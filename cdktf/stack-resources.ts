import { Construct } from "constructs";
import { App, TerraformStack } from "cdktf";
import { DataAwsSubnetIds, DataAwsVpc } from "@cdktf/provider-aws/lib/vpc";
import { AwsProvider } from "@cdktf/provider-aws";
import { DataAwsEcsCluster, DataAwsEcsService, EcsTaskDefinition, EcsTaskSet } from "@cdktf/provider-aws/lib/ecs";
import { DataAwsIamRole } from "@cdktf/provider-aws/lib/iam";

export interface WebsiteRootStackOptions {
  environment: string;
  containerName: string;
  region: string;
  imageUri: string;
}

class WebsiteRootStack extends TerraformStack {
  constructor(scope: Construct, name: string, options: WebsiteRootStackOptions) {
    super(scope, name);

    const AccountProvider = new AwsProvider(this, 'website-account-provider', {
      region: 'us-east-1',
      accessKey: process.env.AWS_ACCESS_KEY_ID,
      secretKey: process.env.AWS_SECRET_ACCESS_KEY
    });

    const defaultVpc = new DataAwsVpc(this, 'vpc-website', {
      default: true,
      cidrBlock: "172.31.0.0/16",
      provider: AccountProvider
    });

    const subnetIds = new DataAwsSubnetIds(this, 'subnets-data', {
      vpcId: defaultVpc.id
    })

    const ecsCluster = new DataAwsEcsCluster(this, 'cluster-data', {
      clusterName: `${options.environment}-website-ecs-cluster`
    })

    const ecsService = new DataAwsEcsService(this, 'service-data', {
      clusterArn: ecsCluster.arn,
      serviceName: `${options.environment}-website-ecs-service`
    })

    const ecsTaskExecutionRole = new DataAwsIamRole(this, 'data-task-execution-role', {
      name: 'ecs-task-execution-role'
    })

    const ecsTask = new EcsTaskDefinition(this, `${options.environment}-streamlit-ecs-task`, {
      family: `${options.containerName}`,
      containerDefinitions: JSON.stringify([{
        name: `${options.containerName}`,
        image: `${options.imageUri}`,
        cpu: 512,
        memory: 512,
        essential: true,
        portMappings: [{
          protocol: 'tcp',
          containerPort: 80,
          hostPort: 80
        }]
      }]),
      runtimePlatform: {
        operatingSystemFamily: 'LINUX'
      },
      cpu: '2048',
      memory: '4096',
      executionRoleArn: ecsTaskExecutionRole.arn,
      taskRoleArn: ecsTaskExecutionRole.arn,
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      dependsOn: [ecsTaskExecutionRole, ecsCluster],
      provider: AccountProvider
    });

    new EcsTaskSet(this, `${options.environment}-task-set`, {
      service: ecsService.arn,
      cluster: ecsCluster.arn,
      taskDefinition: ecsTask.arn,
      launchType: "FARGATE",
      networkConfiguration: {
        subnets: subnetIds.ids,
        assignPublicIp: true
      },
      platformVersion: '1.4.0',
      externalId: `${options.environment}-task-set`,
      provider: AccountProvider
    })

  }
}

const app = new App();
new WebsiteRootStack(app, "cdktf", {
  environment: `${process.env.STAGE}`,
  containerName: 'website-application-container',
  region: `${process.env.REGION}`,
  imageUri: `${process.env.FULLNAME}`
});

app.synth();
