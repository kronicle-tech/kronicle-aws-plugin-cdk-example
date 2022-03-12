import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path'
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as syntheticsAlpha from '@aws-cdk/aws-synthetics-alpha';
import {LambdaIntegration} from "aws-cdk-lib/aws-apigateway";

export class ApiLambdaCrudDynamoDBStack extends cdk.Stack {
  private vpc: ec2.Vpc;
  private dynamoDbTable: dynamodb.Table;
  private getAllLambda: lambdaNodeJs.NodejsFunction;
  private getOneLambda: lambdaNodeJs.NodejsFunction;
  private createOneLambda: lambdaNodeJs.NodejsFunction;
  private updateOneLambda: lambdaNodeJs.NodejsFunction;
  private deleteOneLambda: lambdaNodeJs.NodejsFunction;
  private apiGateway: apigateway.RestApi;
  private canary: syntheticsAlpha.Canary;

  constructor(app: cdk.App, id: string, props?: cdk.StackProps) {
    super(app, id, props);

    this.createVpc();
    this.createDynamoDbTable();
    this.createLambdas();
    this.createApiGateway();
    this.createCanary();
  }

  private createVpc() {
    this.vpc = new ec2.Vpc(this, "exampleVpc", {
      vpcName: "example",
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Needed by CloudWatch Synthetics Canary
    this.vpc.addGatewayEndpoint('S3VpcEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    })

    // Needed by CloudWatch Synthetics Canary
    this.vpc.addInterfaceEndpoint('CloudWatchVpcEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH
    })
  }

  private createDynamoDbTable() {
    this.dynamoDbTable = new dynamodb.Table(this, 'items', {
      partitionKey: {
        name: 'itemId',
        type: dynamodb.AttributeType.STRING
      },
      tableName: 'items',

      /**
       *  The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
       * the new table, and it will remain in your account until manually deleted. By setting the policy to
       * DESTROY, cdk destroy will delete the table (even if it has data in it)
       */
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
    });
  }

  private createLambdas() {
    const nodeJsFunctionProps: lambdaNodeJs.NodejsFunctionProps = {
      bundling: {
        externalModules: [
          'aws-sdk', // Use the 'aws-sdk' available in the Lambda runtime
        ],
      },
      depsLockFilePath: path.join(__dirname, 'lambdas', 'package-lock.json'),
      environment: {
        PRIMARY_KEY: 'itemId',
        TABLE_NAME: this.dynamoDbTable.tableName,
      },
      runtime: lambda.Runtime.NODEJS_14_X,
      tracing: lambda.Tracing.PASS_THROUGH
    }

    // Create a Lambda function for each of the CRUD operations
    this.getOneLambda = new lambdaNodeJs.NodejsFunction(this, 'getOneItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'get-one.ts'),
      ...nodeJsFunctionProps,
    });
    this.getAllLambda = new lambdaNodeJs.NodejsFunction(this, 'getAllItemsFunction', {
      entry: path.join(__dirname, 'lambdas', 'get-all.ts'),
      ...nodeJsFunctionProps,
    });
    this.createOneLambda = new lambdaNodeJs.NodejsFunction(this, 'createItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'create.ts'),
      ...nodeJsFunctionProps,
    });
    this.updateOneLambda = new lambdaNodeJs.NodejsFunction(this, 'updateItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'update-one.ts'),
      ...nodeJsFunctionProps,
    });
    this.deleteOneLambda = new lambdaNodeJs.NodejsFunction(this, 'deleteItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'delete-one.ts'),
      ...nodeJsFunctionProps,
    });

    // Grant the Lambda function read access to the DynamoDB table
    this.dynamoDbTable.grantReadWriteData(this.getAllLambda);
    this.dynamoDbTable.grantReadWriteData(this.getOneLambda);
    this.dynamoDbTable.grantReadWriteData(this.createOneLambda);
    this.dynamoDbTable.grantReadWriteData(this.updateOneLambda);
    this.dynamoDbTable.grantReadWriteData(this.deleteOneLambda);
  }

  private createApiGateway() {
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'lambdaSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      securityGroupName: 'LambdaSecurityGroup'
    });

    lambdaSecurityGroup.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443))

    const vpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'apiVpcEndpoint', {
      vpc: this.vpc,
      service: {
        name: 'com.amazonaws.us-west-2.execute-api',
        port: 443
      },
      subnets: {
        subnets: this.vpc.publicSubnets
      },
      privateDnsEnabled: true,
      securityGroups: [lambdaSecurityGroup]
    })

    // Create an API Gateway resource for each of the CRUD operations
    this.apiGateway = new apigateway.RestApi(this, 'itemsApi', {
      restApiName: 'Items Service',
      endpointTypes: [apigateway.EndpointType.PRIVATE],
      deployOptions: {
        tracingEnabled: true
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: iam.Effect.DENY,
            conditions: {
              StringNotEquals: {
                "aws:SourceVpce": vpcEndpoint.vpcEndpointId
              }
            }
          }),
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: iam.Effect.ALLOW
          })
        ]
      })
    });

    // Integrate the Lambda functions with the API Gateway resource
    const getAllIntegration = new LambdaIntegration(this.getAllLambda);
    const createOneIntegration = new LambdaIntegration(this.createOneLambda);
    const getOneIntegration = new LambdaIntegration(this.getOneLambda);
    const updateOneIntegration = new LambdaIntegration(this.updateOneLambda);
    const deleteOneIntegration = new LambdaIntegration(this.deleteOneLambda);

    const items = this.apiGateway.root.addResource('items');
    items.addMethod('GET', getAllIntegration);
    items.addMethod('POST', createOneIntegration);
    addCorsOptions(items);

    const singleItem = items.addResource('{id}');
    singleItem.addMethod('GET', getOneIntegration);
    singleItem.addMethod('PATCH', updateOneIntegration);
    singleItem.addMethod('DELETE', deleteOneIntegration);
    addCorsOptions(singleItem);
  }

  private createCanary() {
    this.canary = new syntheticsAlpha.Canary(this, 'itemsCanary', {
      schedule: syntheticsAlpha.Schedule.rate(cdk.Duration.hours(2)),
      test: syntheticsAlpha.Test.custom({
        code: syntheticsAlpha.Code.fromAsset(path.join(__dirname, 'canary')),
        handler: 'all-endpoints.handler',
      }),
      runtime: syntheticsAlpha.Runtime.SYNTHETICS_NODEJS_PUPPETEER_3_3,
      environmentVariables: {
        API_BASE_URL: this.apiGateway.url,
      },
    });

    // Based on work-arounds in https://github.com/aws/aws-cdk/issues/9954
    this.canary.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AWSLambdaVPCAccessExecutionRole'
    ))

    const canarySecurityGroup = new ec2.SecurityGroup(this, 'canarySecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      securityGroupName: 'CanarySecurityGroup'
    });

    canarySecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic())

    const cfnCanary = this.canary.node.defaultChild as synthetics.CfnCanary;

    cfnCanary.vpcConfig = {
      vpcId: this.vpc.vpcId,
      securityGroupIds: [canarySecurityGroup.securityGroupId],
      subnetIds: this.vpc.publicSubnets.map(it => it.subnetId)
    };
  }
}

export function addCorsOptions(apiResource: apigateway.IResource) {
  apiResource.addMethod('OPTIONS', new apigateway.MockIntegration({
    integrationResponses: [{
      statusCode: '200',
      responseParameters: {
        'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'method.response.header.Access-Control-Allow-Origin': "'*'",
        'method.response.header.Access-Control-Allow-Credentials': "'false'",
        'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,PUT,POST,DELETE'",
      },
    }],
    passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
    requestTemplates: {
      "application/json": "{\"statusCode\": 200}"
    },
  }), {
    methodResponses: [{
      statusCode: '200',
      responseParameters: {
        'method.response.header.Access-Control-Allow-Headers': true,
        'method.response.header.Access-Control-Allow-Methods': true,
        'method.response.header.Access-Control-Allow-Credentials': true,
        'method.response.header.Access-Control-Allow-Origin': true,
      },
    }]
  })
}

const app = new cdk.App();
new ApiLambdaCrudDynamoDBStack(app, 'ApiLambdaCrudDynamoDBExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
app.synth();
