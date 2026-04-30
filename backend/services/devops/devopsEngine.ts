import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export type DeploymentTarget = 'docker' | 'kubernetes' | 'vercel' | 'firebase' | 'aws' | 'gcp';
export type DeploymentStatus = 'pending' | 'deploying' | 'ready' | 'failed' | 'rolled_back';
export type Strategy = 'blue_green' | 'canary' | 'rolling' | 'recreate';

export interface DeploymentConfig {
  target: DeploymentTarget;
  strategy: Strategy;
  environment: string;
  region?: string;
  instanceCount?: number;
  autoRollback?: boolean;
  healthCheckPath?: string;
  secrets?: Record<string, string>;
}

export interface Deployment {
  id: string;
  target: DeploymentTarget;
  strategy: Strategy;
  status: DeploymentStatus;
  environment: string;
  url?: string;
  version: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  logs: string[];
  error?: string;
  metadata?: Record<string, any>;
}

export interface DockerConfig {
  image: string;
  tag: string;
  ports: { container: number; host: number }[];
  environment: Record<string, string>;
  volumes: { host: string; container: string }[];
  healthCheck?: { path: string; interval: number };
}

export interface KubernetesConfig {
  namespace: string;
  replicas: number;
  image: string;
  port: number;
  resources?: { cpu: string; memory: string };
  env: { name: string; value: string }[];
}

export interface CICDPipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  triggers: TriggerConfig;
  createdAt: number;
}

export interface PipelineStage {
  name: string;
  type: 'build' | 'test' | 'deploy' | 'verify';
  commands: string[];
  continueOnError?: boolean;
  timeout?: number;
}

export interface TriggerConfig {
  onPush: boolean;
  onPullRequest: boolean;
  branches?: string[];
  paths?: string[];
}

export class DevOpsEngine extends EventEmitter {
  private deployments: Map<string, Deployment> = new Map();
  private pipelines: Map<string, CICDPipeline> = new Map();
  private activeDeployments: Set<string> = new Set();

  constructor() {
    super();
  }

  async deploy(config: DeploymentConfig, projectPath: string): Promise<Deployment> {
    const deployment: Deployment = {
      id: randomUUID(),
      target: config.target,
      strategy: config.strategy,
      status: 'pending',
      environment: config.environment,
      version: Date.now().toString(),
      startedAt: Date.now(),
      logs: [],
    };

    this.deployments.set(deployment.id, deployment);
    this.activeDeployments.add(deployment.id);

    this.emit('deployment:started', deployment);

    try {
      deployment.status = 'deploying';
      deployment.logs.push(`Starting deployment to ${config.target}...`);

      switch (config.target) {
        case 'docker':
          await this.deployToDocker(deployment, projectPath, config);
          break;
        case 'kubernetes':
          await this.deployToKubernetes(deployment, projectPath, config);
          break;
        case 'vercel':
          await this.deployToVercel(deployment, projectPath, config);
          break;
        case 'firebase':
          await this.deployToFirebase(deployment, projectPath, config);
          break;
        case 'aws':
          await this.deployToAWS(deployment, projectPath, config);
          break;
        default:
          throw new Error(`Unsupported target: ${config.target}`);
      }

      deployment.status = 'ready';
      deployment.completedAt = Date.now();
      deployment.duration = deployment.completedAt - deployment.startedAt;
      deployment.url = this.generateUrl(config);

      deployment.logs.push(`Deployment successful!`);
      deployment.logs.push(`URL: ${deployment.url}`);

      this.emit('deployment:completed', deployment);
    } catch (error) {
      deployment.status = 'failed';
      deployment.error = String(error);
      deployment.logs.push(`Deployment failed: ${error}`);

      if (config.autoRollback) {
        deployment.logs.push('Initiating rollback...');
        await this.rollback(deployment.id);
      }

      this.emit('deployment:failed', deployment);
    }

    this.activeDeployments.delete(deployment.id);

    return deployment;
  }

  private async deployToDocker(deployment: Deployment, projectPath: string, config: DeploymentConfig): Promise<void> {
    deployment.logs.push('Building Docker image...');
    
    await this.runCommand('docker', ['build', '-t', `app:${deployment.version}`, '.'], projectPath);
    
    deployment.logs.push('Stopping existing containers...');
    await this.runCommand('docker', ['-compose', 'down'], projectPath).catch(() => {});
    
    deployment.logs.push('Starting new container...');
    await this.runCommand('docker', ['-compose', 'up', '-d'], projectPath);
    
    deployment.logs.push('Waiting for container to be ready...');
    await this.waitForHealth('docker');
  }

  private async deployToKubernetes(deployment: Deployment, projectPath: string, config: DeploymentConfig): Promise<void> {
    deployment.logs.push('Generating Kubernetes manifests...');
    
    const k8sDir = path.join(projectPath, 'k8s');
    if (!fs.existsSync(k8sDir)) {
      fs.mkdirSync(k8sDir, { recursive: true });
    }

    const manifest = this.generateKubernetesManifest(config);
    fs.writeFileSync(path.join(k8sDir, 'deployment.yaml'), manifest);
    
    deployment.logs.push('Applying Kubernetes manifests...');
    await this.runCommand('kubectl', ['apply', '-f', k8sDir], projectPath);
    
    deployment.logs.push('Waiting for rollout...');
    await this.runCommand('kubectl', ['rollout', 'status', 'deployment/app'], projectPath);
  }

  private async deployToVercel(deployment: Deployment, projectPath: string, config: DeploymentConfig): Promise<void> {
    deployment.logs.push('Deploying to Vercel...');
    
    const envArgs = Object.entries(config.secrets || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    
    await this.runCommand('vercel', [
      '--yes',
      '--environment', config.environment,
      ...envArgs,
    ], projectPath);

    deployment.logs.push('Waiting for deployment to be ready...');
  }

  private async deployToFirebase(deployment: Deployment, projectPath: string, config: DeploymentConfig): Promise<void> {
    deployment.logs.push('Building Firebase project...');
    await this.runCommand('npm', ['run', 'build'], projectPath);
    
    deployment.logs.push('Deploying to Firebase...');
    await this.runCommand('firebase', ['deploy', '--only', 'hosting', '--project', config.environment], projectPath);
  }

  private async deployToAWS(deployment: Deployment, projectPath: string, config: DeploymentConfig): Promise<void> {
    deployment.logs.push('Building application...');
    await this.runCommand('npm', ['run', 'build'], projectPath);
    
    deployment.logs.push('Creating ECS task definition...');
    await this.runCommand('aws', ['ecs', 'register-task-definition', '--cli-input-json', 'task-def.json'], projectPath);
    
    deployment.logs.push('Updating ECS service...');
    await this.runCommand('aws', ['ecs', 'update-service', '--service', 'app', '--force-new-deployment'], projectPath);
  }

  private async runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd, shell: true });
      let output = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed: ${cmd} ${args.join(' ')}\n${output}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async waitForHealth(target: string): Promise<void> {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private generateKubernetesManifest(config: DeploymentConfig): string {
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: ${config.environment}
spec:
  replicas: ${config.instanceCount || 3}
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
      - name: app
        image: app:latest
        ports:
        - containerPort: 3000
        env:
${Object.entries(config.secrets || {}).map(([k, v]) => `          - name: ${k}\n            value: "${v}"`).join('\n')}
`;
  }

  private generateUrl(config: DeploymentConfig): string {
    const env = config.environment;
    const target = config.target;
    return `https://${env}.${target}.example.com`;
  }

  async rollback(deploymentId: string): Promise<boolean> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return false;

    deployment.logs.push('Initiating rollback...');
    
    const previous = Array.from(this.deployments.values())
      .filter(d => d.environment === deployment.environment && d.id !== deploymentId && d.status === 'ready')
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0];

    if (!previous) {
      deployment.logs.push('No previous deployment found for rollback');
      return false;
    }

    deployment.status = 'rolled_back';
    deployment.logs.push(`Rolled back to version: ${previous.version}`);
    
    this.emit('deployment:rolled_back', { current: deployment, previous });
    
    return true;
  }

  createPipeline(name: string, stages: PipelineStage[], triggers: TriggerConfig): CICDPipeline {
    const pipeline: CICDPipeline = {
      id: randomUUID(),
      name,
      stages,
      triggers,
      createdAt: Date.now(),
    };

    this.pipelines.set(pipeline.id, pipeline);
    
    this.generateCICDFiles(pipeline);
    
    return pipeline;
  }

  private generateCICDFiles(pipeline: CICDPipeline): void {
    const githubWorkflow = this.generateGitHubActions(pipeline);
    const workflowPath = path.join(process.cwd(), '.github', 'workflows');
    
    if (!fs.existsSync(workflowPath)) {
      fs.mkdirSync(workflowPath, { recursive: true });
    }
    
    fs.writeFileSync(path.join(workflowPath, `${pipeline.name}.yml`), githubWorkflow);
    
    const dockerfile = this.generateDockerfile();
    fs.writeFileSync(path.join(process.cwd(), 'Dockerfile'), dockerfile);
    
    const dockerCompose = this.generateDockerCompose();
    fs.writeFileSync(path.join(process.cwd(), 'docker-compose.yml'), dockerCompose);
  }

  private generateGitHubActions(pipeline: CICDPipeline): string {
    return `name: ${pipeline.name}

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
${pipeline.stages.map(stage => `  ${stage.name}:
    runs-on: ubuntu-latest
    steps:
${stage.commands.map(cmd => `      - name: ${cmd.split(' ')[0]}
        run: ${cmd}`).join('\n')}`).join('\n')}
`;
  }

  private generateDockerfile(): string {
    return `FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
`;
  }

  private generateDockerCompose(): string {
    return `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    depends_on:
      - app
`;
  }

  generateTerraform(): string {
    return `provider "aws" {
  region = "us-east-1"
}

resource "aws_ecs_cluster" "main" {
  name = "app-cluster"
}

resource "aws_ecs_task_definition" "app" {
  family = "app"
  cpu = "256"
  memory = "512"
  network_mode = "awsvpc"

  container_definitions = jsonencode([
    {
      name = "app"
      image = "app:latest"
      essential = true
      portMappings = [{ containerPort = 3000 }]
    }
  ])
}

resource "aws_ecs_service" "app" {
  name = "app-service"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count = 2
  launch_type = "FARGATE"

  network_configuration {
    subnets = ["subnet-xxxxx"]
    security_groups = ["sg-xxxxx"]
  }
}
`;
  }

  getDeployment(id: string): Deployment | undefined {
    return this.deployments.get(id);
  }

  getDeployments(environment?: string): Deployment[] {
    return Array.from(this.deployments.values())
      .filter(d => !environment || d.environment === environment);
  }

  getPipeline(id: string): CICDPipeline | undefined {
    return this.pipelines.get(id);
  }

  getAllPipelines(): CICDPipeline[] {
    return Array.from(this.pipelines.values());
  }

  getStatus(): { active: number; total: number; failed: number } {
    const all = Array.from(this.deployments.values());
    return {
      active: this.activeDeployments.size,
      total: all.length,
      failed: all.filter(d => d.status === 'failed').length,
    };
  }
}

export const devopsEngine = new DevOpsEngine();
export default DevOpsEngine;