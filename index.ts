import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as syntheticsAlpha from '@aws-cdk/aws-synthetics-alpha';
import * as path from 'path'

export class LambdaExampleStack extends cdk.Stack {
  private vpc: ec2.IVpc;
  private dynamoDbTable: dynamodb.Table;
  private getAllItemsLambda: lambdaNodeJs.NodejsFunction;
  private getItemLambda: lambdaNodeJs.NodejsFunction;
  private createItemLambda: lambdaNodeJs.NodejsFunction;
  private updateItemLambda: lambdaNodeJs.NodejsFunction;
  private deleteAllItemsLambda: lambdaNodeJs.NodejsFunction;
  private deleteItemLambda: lambdaNodeJs.NodejsFunction;
  private apiGateway: apigateway.RestApi;
  private canary: syntheticsAlpha.Canary;

  constructor(app: cdk.App, id: string, props?: cdk.StackProps) {
    super(app, id, props);

    this.lookupVpc();
    this.createDynamoDbTable();
    this.createLambdas();
    this.createApiGateway();
    this.createCanary();
  }

  private lookupVpc() {
    this.vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      vpcName: "kronicle",
    });
  }

  private createDynamoDbTable() {
    this.dynamoDbTable = new dynamodb.Table(this, 'LambdaExampleDynamoDbTable', {
      partitionKey: {
        name: 'itemId',
        type: dynamodb.AttributeType.STRING
      },
      tableName: 'lambda-example-dynamodb-table',

      /**
       *  The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
       * the new table, and it will remain in your account until manually deleted. By setting the policy to
       * DESTROY, cdk destroy will delete the table (even if it has data in it)
       */
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
    });
    cdk.Tags.of(this.dynamoDbTable).add('aliases', 'lambda-example-dynamodb-table');
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
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.seconds(10)
    }

    // Create a Lambda function for each of the CRUD operations
    this.getItemLambda = new lambdaNodeJs.NodejsFunction(this, 'GetItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'get-one.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-get-item-function'
    });
    this.getAllItemsLambda = new lambdaNodeJs.NodejsFunction(this, 'GetAllItemsFunction', {
      entry: path.join(__dirname, 'lambdas', 'get-all.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-get-all-items-function'
    });
    this.deleteAllItemsLambda = new lambdaNodeJs.NodejsFunction(this, 'DeleteAllItemsFunction', {
      entry: path.join(__dirname, 'lambdas', 'delete-all.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-delete-all-items-function',
      timeout: cdk.Duration.minutes(15)
    });
    this.createItemLambda = new lambdaNodeJs.NodejsFunction(this, 'CreateItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'create.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-create-item-function'
    });
    this.updateItemLambda = new lambdaNodeJs.NodejsFunction(this, 'UpdateItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'update-one.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-update-item-function'
    });
    this.deleteItemLambda = new lambdaNodeJs.NodejsFunction(this, 'DeleteItemFunction', {
      entry: path.join(__dirname, 'lambdas', 'delete-one.ts'),
      ...nodeJsFunctionProps,
      functionName: 'lambda-example-delete-item-function'
    });

    // Grant the Lambda function read access to the DynamoDB table
    this.dynamoDbTable.grantReadWriteData(this.getAllItemsLambda);
    this.dynamoDbTable.grantReadWriteData(this.getItemLambda);
    this.dynamoDbTable.grantReadWriteData(this.createItemLambda);
    this.dynamoDbTable.grantReadWriteData(this.updateItemLambda);
    this.dynamoDbTable.grantReadWriteData(this.deleteAllItemsLambda);
    this.dynamoDbTable.grantReadWriteData(this.deleteItemLambda);
  }

  private createApiGateway() {
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'ApiGatewaySecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      securityGroupName: 'lambda-example-api-gateway-security-group'
    });

    lambdaSecurityGroup.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443))

    const vpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiVpcEndpoint', {
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
    this.apiGateway = new apigateway.RestApi(this, 'ApiGateway', {
      restApiName: 'lambda-example-api',
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
    cdk.Tags.of(this.apiGateway).add('aliases', 'lambda-example-api-prod');

    // Integrate the Lambda functions with the API Gateway resource
    const getAllIntegration = new apigateway.LambdaIntegration(this.getAllItemsLambda);
    const createOneIntegration = new apigateway.LambdaIntegration(this.createItemLambda);
    const deleteAllIntegration = new apigateway.LambdaIntegration(this.deleteAllItemsLambda);
    const getOneIntegration = new apigateway.LambdaIntegration(this.getItemLambda);
    const updateOneIntegration = new apigateway.LambdaIntegration(this.updateItemLambda);
    const deleteOneIntegration = new apigateway.LambdaIntegration(this.deleteItemLambda);

    const items = this.apiGateway.root.addResource('items');
    items.addMethod('GET', getAllIntegration);
    items.addMethod('POST', createOneIntegration);
    items.addMethod('DELETE', deleteAllIntegration);
    addCorsOptions(items);

    const singleItem = items.addResource('{id}');
    singleItem.addMethod('GET', getOneIntegration);
    singleItem.addMethod('PATCH', updateOneIntegration);
    singleItem.addMethod('DELETE', deleteOneIntegration);
    addCorsOptions(singleItem);
  }

  private createCanary() {
    this.canary = new syntheticsAlpha.Canary(this, 'Canary', {
      canaryName: 'lambda-example-canary',
      schedule: syntheticsAlpha.Schedule.rate(cdk.Duration.minutes(60)),
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

    const canarySecurityGroup = new ec2.SecurityGroup(this, 'CanarySecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      securityGroupName: 'lambda-example-canary-security-group'
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
new LambdaExampleStack(app, 'LambdaExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  }
});
cdk.Tags.of(app).add('team', 'kronicle-project');
cdk.Tags.of(app).add('component', 'lambda-example');
cdk.Tags.of(app).add('example', 'true');
app.synth();
