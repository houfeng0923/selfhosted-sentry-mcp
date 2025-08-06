#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ini from 'ini';

// 读取 ~/.sentryclirc
function readSentryCliRc() {
  const rcPath = path.join(os.homedir(), '.sentryclirc');
  if (!fs.existsSync(rcPath)) return {};
  const content = fs.readFileSync(rcPath, 'utf-8');
  return ini.parse(content);
}

const rc = readSentryCliRc();

const SENTRY_URL = process.env.SENTRY_URL || rc.defaults?.url;
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || rc.auth?.token;
const SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || rc.defaults?.org;

if (!SENTRY_URL) throw new Error('SENTRY_URL 环境变量和 ~/.sentryclirc 都没配！');
if (!SENTRY_AUTH_TOKEN) throw new Error('SENTRY_AUTH_TOKEN 环境变量和 ~/.sentryclirc 都没配！');
if (!SENTRY_ORG_SLUG) throw new Error('SENTRY_ORG_SLUG 环境变量和 ~/.sentryclirc 都没配！');

// Validate the URL format basic check
try {
  new URL(SENTRY_URL);
} catch (e) {
  throw new Error(`Invalid SENTRY_URL format: ${SENTRY_URL}`);
}

const SENTRY_BASE_URL = SENTRY_URL.endsWith('/') ? SENTRY_URL.slice(0, -1) : SENTRY_URL;
const ORG_SLUG = SENTRY_ORG_SLUG;

const isValidGetIssueArgs = (args: any): args is { issue_id_or_url: string } =>
  typeof args === 'object' && args !== null && typeof args.issue_id_or_url === 'string';

const isValidListIssuesArgs = (args: any): args is { project_slug: string; query?: string; status?: string } =>
  typeof args === 'object' && args !== null && typeof args.project_slug === 'string' &&
  (args.query === undefined || typeof args.query === 'string') &&
  (args.status === undefined || typeof args.status === 'string');

const isValidGetEventArgs = (args: any): args is { project_slug: string; event_id: string } =>
    typeof args === 'object' && args !== null && typeof args.project_slug === 'string' && typeof args.event_id === 'string';

const isValidUpdateIssueArgs = (args: any): args is { issue_id: string; status: 'resolved' | 'ignored' | 'unresolved' } =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' &&
    typeof args.status === 'string' && ['resolved', 'ignored', 'unresolved'].includes(args.status);

const isValidCreateCommentArgs = (args: any): args is { issue_id: string; comment_text: string } =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' && typeof args.comment_text === 'string';

const getIssueId = (input: string): string | null => {
  try {
    const url = new URL(input);
    const pathParts = url.pathname.split('/');
    const issuesIndex = pathParts.indexOf('issues');
    if (issuesIndex !== -1 && pathParts.length > issuesIndex + 1) {
      const potentialId = pathParts[issuesIndex + 1];
      if (/^\d+$/.test(potentialId)) return potentialId;
    }
  } catch (e) {
    if (/^\d+$/.test(input)) return input;
  }
  return null;
};

class SelfHostedSentryServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'sentry-mcp',
        version: '0.1.0',
        description: 'MCP server for self-hosted Sentry instances, 支持自动读取 ~/.sentryclirc。',
      },
      { capabilities: { resources: {}, tools: {} } }
    );

    this.axiosInstance = axios.create({
      baseURL: `${SENTRY_BASE_URL}/api/0/`,
      headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => { await this.server.close(); process.exit(0); });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_sentry_issue',
          description: 'Retrieve details for a specific Sentry issue by ID or URL.',
          inputSchema: { type: 'object', properties: { issue_id_or_url: { type: 'string', description: 'Sentry issue ID or full issue URL.' } }, required: ['issue_id_or_url'] },
        },
        {
            name: 'list_sentry_projects',
            description: 'List all projects within the configured Sentry organization.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'list_sentry_issues',
            description: 'List issues for a specific project, optionally filtering by query or status.',
            inputSchema: {
                type: 'object',
                properties: {
                    project_slug: { type: 'string', description: 'The slug of the project (e.g., "my-web-app").' },
                    query: { type: 'string', description: 'Optional Sentry search query (e.g., "is:unresolved environment:production").' },
                    status: { type: 'string', enum: ['resolved', 'unresolved', 'ignored'], description: 'Optional issue status filter.' },
                },
                required: ['project_slug'],
            },
        },
        {
            name: 'get_sentry_event_details',
            description: 'Retrieve details for a specific event ID within a project.',
            inputSchema: {
                type: 'object',
                properties: {
                    project_slug: { type: 'string', description: 'The slug of the project.' },
                    event_id: { type: 'string', description: 'The ID of the event.' },
                },
                required: ['project_slug', 'event_id'],
            },
        },
        {
            name: 'update_sentry_issue_status',
            description: 'Update the status of a Sentry issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    issue_id: { type: 'string', description: 'The ID of the issue to update.' },
                    status: { type: 'string', enum: ['resolved', 'ignored', 'unresolved'], description: 'The new status for the issue.' },
                },
                required: ['issue_id', 'status'],
            },
        },
        {
            name: 'create_sentry_issue_comment',
            description: 'Add a comment to a Sentry issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    issue_id: { type: 'string', description: 'The ID of the issue to comment on.' },
                    comment_text: { type: 'string', description: 'The text content of the comment.' },
                },
                required: ['issue_id', 'comment_text'],
            },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      try {
        if (toolName === 'get_sentry_issue') {
          if (!isValidGetIssueArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_sentry_issue.');
          const issueId = getIssueId(args.issue_id_or_url);
          if (!issueId) throw new McpError(ErrorCode.InvalidParams, `Could not extract issue ID from: ${args.issue_id_or_url}`);
          const response = await this.axiosInstance.get(`issues/${issueId}/`);
          return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else if (toolName === 'list_sentry_projects') {
            const response = await this.axiosInstance.get(`organizations/${ORG_SLUG}/projects/`);
            return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else if (toolName === 'list_sentry_issues') {
            if (!isValidListIssuesArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_sentry_issues.');
            const params: Record<string, string> = {};
            if (args.query) params.query = args.query;
            if (args.status) params.query = (params.query ? params.query + ' ' : '') + `is:${args.status}`;
            const response = await this.axiosInstance.get(`projects/${ORG_SLUG}/${args.project_slug}/issues/`, { params });
            return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else if (toolName === 'get_sentry_event_details') {
            if (!isValidGetEventArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_sentry_event_details.');
            const response = await this.axiosInstance.get(`projects/${ORG_SLUG}/${args.project_slug}/events/${args.event_id}/`);
            return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else if (toolName === 'update_sentry_issue_status') {
            if (!isValidUpdateIssueArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid args for update_sentry_issue_status.');
            const response = await this.axiosInstance.put(`issues/${args.issue_id}/`, { status: args.status });
            return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else if (toolName === 'create_sentry_issue_comment') {
            if (!isValidCreateCommentArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid args for create_sentry_issue_comment.');
            const response = await this.axiosInstance.post(`issues/${args.issue_id}/comments/`, { text: args.comment_text });
            return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
        }
        else {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }
      } catch (error) {
        let errorMessage = `Failed to execute tool ${toolName}.`;
        let isClientError = false;
        if (axios.isAxiosError(error)) {
          errorMessage = `Sentry API error for ${toolName}: ${error.message}`;
          if (error.response) {
            errorMessage += ` Status: ${error.response.status}. Response: ${JSON.stringify(error.response.data)}`;
            if (error.response.status >= 400 && error.response.status < 500) {
                isClientError = true;
                if (error.response.status === 401 || error.response.status === 403) {
                  errorMessage = `Sentry API permission denied for ${toolName}. Check auth token validity and permissions.`;
                } else if (error.response.status === 404) {
                  errorMessage = `Sentry resource not found for ${toolName}. Check IDs/slugs.`;
                }
            }
          }
        } else if (error instanceof McpError) {
            throw error;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        }
        return {
            content: [{ type: 'text', text: errorMessage }],
            isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Sentry MCP server v0.1.0 running for org "${ORG_SLUG}" at ${SENTRY_BASE_URL}`);
  }
}

const server = new SelfHostedSentryServer();
server.run().catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
}); 