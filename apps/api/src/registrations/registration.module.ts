import { Module } from '@nestjs/common';
import { WorkflowModule } from '../activities/workflow.module.js';
import { RegistrationController } from './registration.controller.js';

@Module({ imports: [WorkflowModule], controllers: [RegistrationController] })
export class RegistrationModule {}
