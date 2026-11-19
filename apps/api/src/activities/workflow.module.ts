import { Module } from '@nestjs/common';
import { Database } from '../database.js';
import { Workflow } from './workflow.js';

@Module({ providers: [Database, Workflow], exports: [Database, Workflow] })
export class WorkflowModule {}
