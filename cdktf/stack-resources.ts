import { Construct } from "constructs";
import { App, TerraformStack, RemoteBackend } from "cdktf";
import { DataAwsVpc, InternetGateway, RouteTable, RouteTableAssociation, SecurityGroup, Subnet } from "@cdktf/provider-aws/lib/vpc";
import { AwsProvider } from "@cdktf/provider-aws";
import { Lb, LbListener, LbTargetGroup } from "@cdktf/provider-aws/lib/elb";
import { EcsCluster, EcsService, EcsTaskDefinition } from "@cdktf/provider-aws/lib/ecs";
import { IamRole } from "@cdktf/provider-aws/lib/iam";
import { DataAwsRoute53Zone, Route53Record } from "@cdktf/provider-aws/lib/route53";
import { AcmCertificate } from "@cdktf/provider-aws/lib/acm/acm-certificate";
import { AcmCertificateValidation } from "@cdktf/provider-aws/lib/acm";

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
      profile: 'default'
    });

    const defaultVpc = new DataAwsVpc(this, 'vpc-website', {
      default: true,
      cidrBlock: "172.31.0.0/16",
      provider: AccountProvider
    });

    const subnetPublic2a = new Subnet(this, 'subnet-2a', {
      cidrBlock: '172.31.0.0/17',
      vpcId: defaultVpc.id,
      availabilityZone: `${options.region}a`,
      mapPublicIpOnLaunch: true,
      provider: AccountProvider,
      dependsOn: [defaultVpc]
    });

    const subnetPublic2b = new Subnet(this, 'subnet-2b', {
      cidrBlock: '172.31.128.0/17',
      vpcId: defaultVpc.id,
      availabilityZone: `${options.region}b`,
      mapPublicIpOnLaunch: true,
      provider: AccountProvider,
      dependsOn: [defaultVpc]
    });

    const vpcInternetGateway = new InternetGateway(this, 'internet-gateway', {
      vpcId: defaultVpc.id,
      dependsOn: [subnetPublic2a, subnetPublic2b],
      provider: AccountProvider
    });

    const subnetRouteTable = new RouteTable(this, 'subnet-route-table', {
      vpcId: defaultVpc.id,
      route: [{
        cidrBlock: '0.0.0.0/0',
        gatewayId: vpcInternetGateway.id,
      }],
      dependsOn: [vpcInternetGateway],
      provider: AccountProvider
    });

    const rtAssociation2a = new RouteTableAssociation(this, 'subnet-rt-2a',{
      subnetId: subnetPublic2a.id,
      routeTableId: subnetRouteTable.id,
      dependsOn:[subnetRouteTable],
      provider: AccountProvider
    });

    const rtAssociation2b = new RouteTableAssociation(this, 'subnet-rt-2b',{
      subnetId: subnetPublic2b.id,
      routeTableId: subnetRouteTable.id,
      dependsOn:[subnetRouteTable],
      provider: AccountProvider
    });


    const loadBalancerSecurityGroup = new SecurityGroup(this, 'load-balancer-sg',{
      name: 'website-load-balancer-sg',
      description: 'load balancer security group to allow public traffic',
      // ingress to port 80 from any traffic
      ingress: [{
        cidrBlocks: ['0.0.0.0/0'],
        fromPort: 80,
        toPort: 80,
        protocol: 'TCP'
      }],
      // egress allow all
      egress: [{
        cidrBlocks: ['0.0.0.0/0'],
        fromPort: 0,
        toPort: 0,
        // any protocol
        protocol: '-1',
      }],
      vpcId: defaultVpc.id,
      dependsOn: [defaultVpc],
      provider: AccountProvider
    });

    const vpcSecurityGroup = new SecurityGroup(this, 'website-vpc-sg', {
      name: 'website-vpc-sg',
      description: 'security group to allow traffic only from load balancer',
      ingress: [{
        securityGroups: [loadBalancerSecurityGroup.id],
        fromPort: 1,
        toPort: 65535,
        protocol: 'TCP'
      }],
      // egress allow all
      egress: [{
        cidrBlocks: ['0.0.0.0/0'],
        fromPort: 0,
        toPort: 0,
        // any protocol
        protocol: '-1',
      }],
      vpcId: defaultVpc.id,
      dependsOn: [loadBalancerSecurityGroup],
      provider: AccountProvider
    });

    const albTargetGroup = new LbTargetGroup(this, 'load-balancer-target-group',{
      vpcId: defaultVpc.id,
      targetType: 'ip',
      protocol: 'HTTP',
      port: 80,
      dependsOn: [rtAssociation2a, rtAssociation2b],
      provider: AccountProvider
    });

    const applicationLoadBalancer = new Lb(this, 'application-load-balancer', {
      name: 'website-alb',
      loadBalancerType: 'application',
      internal: false,
      securityGroups: [loadBalancerSecurityGroup.id],
      subnets: [subnetPublic2a.id, subnetPublic2b.id],
      dependsOn: [rtAssociation2a, rtAssociation2b],
      provider: AccountProvider
    });

    const albListener = new LbListener(this, 'load-balancer-listener', {
      loadBalancerArn: applicationLoadBalancer.arn,
      defaultAction: [{
        type: 'forward',
        targetGroupArn: albTargetGroup.arn
      }],
      port: 80,
      protocol: 'HTTP',
      dependsOn: [applicationLoadBalancer, albTargetGroup]
    });

    const ecsCluster = new EcsCluster(this, `${options.environment}-website-ecs-cluster`, {
      name: `${options.environment}-website-ecs-cluster`,
      provider: AccountProvider,
      dependsOn: [albListener]
    });

    const ecsTaskExecutionRole = new IamRole(this, 'ecs-task-execution-role', {
      name: 'ecs-task-execution-role',
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: ['ecs-tasks.amazonaws.com']
            },
            Action: 'sts:AssumeRole'
          }
        ]
      }),
      managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
    });

    const ecsTask = new EcsTaskDefinition(this, `${options.environment}-streamlit-ecs-task`, {
      family: `${options.containerName}`,
      containerDefinitions: JSON.stringify([{
        name: `${options.containerName}`,
        image: `${options.imageUri}`,
        cpu: 512,
        memory: 256,
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

    const ecsService = new EcsService(this, 'website-ecs-service',{
      name: 'website-ecs-service',
      desiredCount: 2,
      taskDefinition: ecsTask.arn,
      loadBalancer: [{
        targetGroupArn: albTargetGroup.arn,
        containerName: `${options.containerName}`,
        containerPort: 80
      }],
      networkConfiguration: {
        securityGroups: [vpcSecurityGroup.id],
        assignPublicIp: true,
        subnets: [subnetPublic2a.id]
      },
      platformVersion: '1.4.0',
      launchType: 'FARGATE',
      cluster: ecsCluster.arn,
      provider: AccountProvider,
      dependsOn: [ecsTask],
      forceNewDeployment: true
    });

    /////////////////////
    // Route53
    /////////////////////

    const route53Zone = new DataAwsRoute53Zone(this, 'website-route-53-zone', {
      name: `${options.environment}.thisissamarpan.com.`,
      provider: AccountProvider,
      dependsOn: [ecsService]
    });

    // certificate
    const cert = new AcmCertificate(this, 'website-cert', {
      domainName: `${options.environment}.thisissamarpan.com`,
      validationMethod: 'DNS',
      provider: AccountProvider,
      dependsOn: [route53Zone]
    });

    // certificate record in the hosted zone
    const certRecord = new Route53Record(this, 'website-route53-record-cert-validation',{
      dependsOn:[route53Zone, cert],
      name: cert.domainValidationOptions.get(0).resourceRecordName,
      records: [cert.domainValidationOptions.get(0).resourceRecordValue],
      type: cert.domainValidationOptions.get(0).resourceRecordType,
      zoneId: route53Zone.zoneId,
      ttl: 300,
      provider: AccountProvider
    });

    // certificate record validation
    new AcmCertificateValidation(this, 'website-cert-validation',{
      dependsOn: [cert, certRecord],
      certificateArn: cert.arn,
      validationRecordFqdns: [certRecord.fqdn],
      provider: AccountProvider
    });

    // alias record to LoadBalancer
    new Route53Record(this, 'website-route-record', {
      name: `${options.environment}.thisissamarpan.com`,
      type: 'A',
      zoneId: route53Zone.zoneId,
      dependsOn: [route53Zone],
      alias: [{
        zoneId: applicationLoadBalancer.zoneId,
        name: applicationLoadBalancer.dnsName,
        evaluateTargetHealth: false
      }],
      provider: AccountProvider
    });
  }
}

const app = new App();
new WebsiteRootStack(app, "cdktf", {
  environment: `${process.env.STAGE}`,
  containerName: 'website-application-container',
  region: `${process.env.REGION}`,
  imageUri: `${process.env.FULLNAME}`
});
// new RemoteBackend(stack, {
//   hostname: "app.terraform.io",
//   organization: "thisissamarpan",
//   workspaces: {
//     name: "thisissamarpan-application"
//   }
// });
app.synth();
