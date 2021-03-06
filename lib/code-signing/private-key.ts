import cfn = require('@aws-cdk/aws-cloudformation');
import iam = require('@aws-cdk/aws-iam');
import kms = require('@aws-cdk/aws-kms');
import lambda = require('@aws-cdk/aws-lambda');
import cdk = require('@aws-cdk/cdk');
import path = require('path');
import { hashFileOrDirectory } from '../util';
import { CertificateSigningRequest, DistinguishedName } from './certificate-signing-request';

export interface RsaPrivateKeySecretProps {
  /**
   * The modulus size of the RSA key that will be generated.
   *
   * The NIST publishes a document that provides guidance on how to select an appropriate key size:
   * @see https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-4/final
   */
  keySize: number;

  /**
   * The name of the AWS Secrets Manager entity that will be created to hold the private key.
   */
  secretName: string;

  /**
   * The description to attach to the AWS Secrets Manager entity that will hold the private key.
   */
  description?: string;

  /**
   * The KMS key to be used for encrypting the AWS Secrets Manager entity.
   *
   * @default the default KMS key will be used in accordance with AWS Secrets Manager default behavior.
   */
  secretEncryptionKey?: kms.IEncryptionKey;

  /**
   * The deletion policy to apply on the Private Key secret.
   *
   * @default Retain
   */
  deletionPolicy?: cdk.DeletionPolicy;
}

/**
 * An OpenSSL-generated RSA Private Key. It can for example be used to obtain a Certificate signed by a Certificate
 * Authority through the use of the ``CertificateSigningRequest`` construct (or via the
 * ``#newCertificateSigningRequest``) method.
 */
export class RsaPrivateKeySecret extends cdk.Construct {
  /**
   * The ARN of the secret that holds the private key.
   */
  public secretArn: string;

  private secretArnLike: string;
  private masterKey?: kms.IEncryptionKey;

  constructor(parent: cdk.Construct, id: string, props: RsaPrivateKeySecretProps) {
    super(parent, id);

    props.deletionPolicy = props.deletionPolicy || cdk.DeletionPolicy.Retain;

    const codeLocation = path.resolve(__dirname, '..', '..', 'custom-resource-handlers', 'bin', 'private-key');
    const customResource = new lambda.SingletonFunction(this, 'ResourceHandler', {
      lambdaPurpose: 'RSAPrivate-Key',
      uuid: '72FD327D-3813-4632-9340-28EC437AA486',
      description: 'Generates an RSA Private Key and stores it in AWS Secrets Manager',
      runtime: lambda.Runtime.NodeJS810,
      handler: 'index.handler',
      code: new lambda.AssetCode(codeLocation),
      timeout: 300,
    });

    this.secretArnLike = cdk.Stack.find(this).formatArn({
      service: 'secretsmanager',
      resource: 'secret',
      sep: ':',
      // The ARN of a secret has "-" followed by 6 random characters appended at the end
      resourceName: `${props.secretName}-??????`
    });
    customResource.addToRolePolicy(new iam.PolicyStatement()
      .addActions('secretsmanager:CreateSecret',
                  'secretsmanager:DeleteSecret',
                  'secretsmanager:UpdateSecret')
      .addResource(this.secretArnLike));

    if (props.secretEncryptionKey) {
      props.secretEncryptionKey.addToResourcePolicy(new iam.PolicyStatement()
        .describe(`Allow use via AWS Secrets Manager by CustomResource handler ${customResource.functionName}`)
        .addAwsPrincipal(customResource.role!.roleArn)
        .addActions('kms:Decrypt', 'kms:GenerateDataKey')
        .addAllResources()
        .addCondition('StringEquals', {
          'kms:ViaService': `secretsmanager.${cdk.Stack.find(this).region}.amazonaws.com`,
        })
        .addCondition('ArnLike', {
          'kms:EncryptionContext:SecretARN': this.secretArnLike
        }));
    }

    const privateKey = new cfn.CustomResource(this, 'Resource', {
      lambdaProvider: customResource,
      resourceType: 'Custom::RsaPrivateKeySecret',
      properties: {
        resourceVersion: hashFileOrDirectory(codeLocation),
        description: props.description,
        keySize: props.keySize,
        secretName: props.secretName,
        kmsKeyId: props.secretEncryptionKey && props.secretEncryptionKey.keyArn,
      }
    });
    if (customResource.role) {
      privateKey.node.addDependency(customResource.role);
      if (props.secretEncryptionKey) {
        // Modeling as a separate Policy to evade a dependency cycle (Role -> Key -> Role), as the Key refers to the
        // role in it's resource policy.
        privateKey.node.addDependency(new iam.Policy(this, 'GrantLambdaRoleKeyAccess', {
          roles: [customResource.role],
          statements: [
            new iam.PolicyStatement()
              .describe(`AWSSecretsManager${props.secretName.replace(/[^0-9A-Za-z]/g, '')}CMK`)
              .addActions('kms:Decrypt', 'kms:GenerateDataKey')
              .addResource(props.secretEncryptionKey.keyArn)
              .addCondition('StringEquals', { 'kms:ViaService': `secretsmanager.${cdk.Stack.find(this).region}.amazonaws.com` })
              .addCondition('StringLike', { 'kms:EncryptionContext:SecretARN': [this.secretArnLike, 'RequestToValidateKeyAccess'] })
          ]
        }));
      }
    }
    privateKey.options.deletionPolicy = props.deletionPolicy;

    this.masterKey = props.secretEncryptionKey;
    this.secretArn = privateKey.getAtt('SecretArn').toString();
  }

  /**
   * Creates a new CSR resource using this private key.
   *
   * @param id               the ID of the construct in the construct tree.
   * @param dn               the distinguished name to record on the CSR.
   * @param keyUsage         the intended key usage (for example: "critical,digitalSignature")
   * @param extendedKeyUsage the indended extended key usage, if any (for example: "critical,digitalSignature")
   *
   * @returns a new ``CertificateSigningRequest`` instance that can be used to access the actual CSR document.
   */
  public newCertificateSigningRequest(id: string, dn: DistinguishedName, keyUsage: string, extendedKeyUsage?: string) {
    return new CertificateSigningRequest(this, id, {
      privateKey: this,
      dn, keyUsage, extendedKeyUsage
    });
  }

  /**
   * Allows a given IAM Role to read the secret value.
   *
   * @param grantee the principal to which permissions should be granted.
   */
  public grantGetSecretValue(grantee: iam.IPrincipal): void {
    grantee.addToPolicy(new iam.PolicyStatement().addAction('secretsmanager:GetSecretValue').addResource(this.secretArn));
    if (this.masterKey) {
      // Add a key grant since we're using a CMK
      this.masterKey.addToResourcePolicy(new iam.PolicyStatement()
        .addAction('kms:Decrypt')
        .addAllResources()
        .addPrincipal(grantee.principal)
        .addCondition('StringEquals', {
          'kms:ViaService': `secretsmanager.${cdk.Stack.find(this).region}.amazonaws.com`,
        })
        .addCondition('ArnLike', {
          'kms:EncryptionContext:SecretARN': this.secretArnLike
        }));
      grantee.addToPolicy(new iam.PolicyStatement()
        .addAction('kms:Decrypt')
        .addResource(this.masterKey.keyArn)
        .addCondition('StringEquals', {
          'kms:ViaService': `secretsmanager.${cdk.Stack.find(this).region}.amazonaws.com`,
        })
        .addCondition('ArnEquals', {
          'kms:EncryptionContext:SecretARN': this.secretArn,
        }));
    }
  }
}
