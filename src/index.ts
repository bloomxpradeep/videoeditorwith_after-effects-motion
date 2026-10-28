#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { Server, ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { z, type ZodTypeAny } from 'zod';
import { PremiereProTools, type ServerApp } from './tools/index.js';
import { PremiereProResources } from './resources/index.js';
import { PremiereProPrompts } from './prompts/index.js';
import { PremiereProBridge } from './bridge/index.js';
import { Logger } from './utils/logger.js';
import { PACKAGE_VERSION } from './version.js';
import { checkForUpdate } from './utils/update-check.js';
import { AE_SERVER_INSTRUCTIONS, MCP_SERVER_INSTRUCTIONS } from './instructions.js';
import { AFTER_EFFECTS_HOST_PROFILE, PREMIERE_HOST_PROFILE } from './bridge/hosts.js';
import {
  getTelemetry,
  summarizeToolFailure,
  type Telemetry,
  type TrackToolCallInput,
} from './utils/telemetry.js';

type ObjectJsonSchema = Record<string, unknown> & { type: 'object' };

/**
 * One binary, two servers. PREMIERE_MCP_APP=aftereffects (or the CLI's
 * "after-effects" command) serves the After Effects and motion workflow tools on
 * the AE bridge folder; anything else serves Premiere exactly as before.
 */
export function resolveServerApp(env: NodeJS.Dict<string | undefined> = process.env): ServerApp {
  const raw = String(env.PREMIERE_MCP_APP ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return raw === 'aftereffects' || raw === 'ae' || raw === 'aeft' ? 'aftereffects' : 'premiere';
}

const AE_PROMPTS = [
  {
    name: 'motion_design_video',
    description: 'Make a motion design video in After Effects from a talking-head clip, step by step: transcribe, references, storyboard, build scene by scene, review, render.',
    arguments: [
      { name: 'video_name', description: 'What to call this video', required: true },
      { name: 'footage_path', description: 'Absolute path to the raw video, if it is already on disk', required: false },
    ],
  },
];

class MCPPremiereProServer {
  private stdioHandle?: StdioServerHandle;
  private tools: PremiereProTools;
  private resources: PremiereProResources;
  private prompts: PremiereProPrompts;
  private bridge: PremiereProBridge;
  private logger: Logger;
  private telemetry: Telemetry;
  private readonly app: ServerApp;

  constructor() {
    this.app = resolveServerApp();
    this.logger = new Logger(this.app === 'aftereffects' ? 'MCPAfterEffectsServer' : 'MCPPremiereProServer');
    this.telemetry = getTelemetry();

    this.bridge = new PremiereProBridge(this.app === 'aftereffects' ? AFTER_EFFECTS_HOST_PROFILE : PREMIERE_HOST_PROFILE);
    this.tools = new PremiereProTools(this.bridge, { app: this.app });
    this.resources = new PremiereProResources(this.bridge);
    this.prompts = new PremiereProPrompts();
  }

  private buildServer(): Server {
    const isAe = this.app === 'aftereffects';
    const server = new Server(
      {
        name: isAe ? 'adobe-after-effects-motion-mcp' : 'adobe-premiere-pro-mcp',
        version: PACKAGE_VERSION,
        description: isAe
          ? 'Model Context Protocol tools for Adobe After Effects motion design: transcribe, storyboard, build scene by scene, review, render'
          : 'Model Context Protocol tools for Adobe Premiere Pro - AI-powered video editing'
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        instructions: isAe ? AE_SERVER_INSTRUCTIONS : MCP_SERVER_INSTRUCTIONS
      }
    );

    this.setupHandlers(server);
    return server;
  }

  private inputSchemaToJsonSchema(inputSchema: ZodTypeAny): ObjectJsonSchema {
    const jsonSchema = z.toJSONSchema(inputSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
    if (jsonSchema.type !== 'object') {
      return { type: 'object', additionalProperties: true };
    }
    return jsonSchema as ObjectJsonSchema;
  }

  private setupHandlers(server: Server): void {
    // List available tools
    server.setRequestHandler('tools/list', async () => {
      const tools = this.tools.getAdvertisedTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.inputSchemaToJsonSchema(tool.inputSchema as ZodTypeAny)
      }));
      return { tools };
    });

    // Execute tool calls
    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;
      const startedAt = Date.now();
      const innerName =
        name === 'invoke_tool' && args && typeof args === 'object' && typeof (args as { name?: unknown }).name === 'string'
          ? String((args as { name: string }).name)
          : undefined;

      try {
        const result = await this.tools.executeTool(name, args || {});
        this.recordToolCall(innerName || name, result, Date.now() - startedAt);
        const toolResult: CallToolResult = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result as Record<string, unknown>,
          isError: result.success === false
        };
        return server.projectCallToolResult(toolResult, undefined);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.recordToolCall(innerName || name, { success: false, error: errorMessage }, Date.now() - startedAt);
        this.logger.error(`Tool execution failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to execute tool '${name}': ${errorMessage}`
        );
      }
    });

    // List available resources
    server.setRequestHandler('resources/list', async () => {
      return {
        resources: this.app === 'aftereffects' ? [] : this.resources.getAvailableResources()
      };
    });

    // Read resource content
    server.setRequestHandler('resources/read', async (request) => {
      const { uri } = request.params;
      
      try {
        const resource = this.app === 'aftereffects' ? undefined : this.resources.getResource(uri);
        if (!resource) {
          throw new Error(`Resource '${uri}' not found`);
        }
        const content = await this.resources.readResource(uri);
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              text
            }
          ]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Resource read failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to read resource '${uri}': ${errorMessage}`
        );
      }
    });

    // List available prompts
    server.setRequestHandler('prompts/list', async () => {
      return {
        prompts: this.app === 'aftereffects' ? AE_PROMPTS : this.prompts.getAvailablePrompts()
      };
    });

    // Get prompt content
    server.setRequestHandler('prompts/get', async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        if (this.app === 'aftereffects') {
          if (name !== 'motion_design_video') throw new Error(`Prompt '${name}' not found`);
          const videoName = String((args as Record<string, unknown> | undefined)?.video_name ?? 'New video');
          const footage = (args as Record<string, unknown> | undefined)?.footage_path;
          return {
            description: AE_PROMPTS[0]!.description,
            messages: [{
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Let's make a motion design video called "${videoName}".`,
                  footage ? `The raw footage is at ${String(footage)}.` : 'I will give you the raw footage.',
                  'Follow the six steps: connect After Effects (ae_verify_connection), transcribe with word timings and confirm names, study my references, write and check a storyboard and wait for my approval before touching After Effects, build scene by scene with named editable layers checking each one, then review everything against my rules before rendering.',
                  'Stop and ask me at each checkpoint.',
                ].join('\n'),
              },
            }],
          };
        }
        const prompt = await this.prompts.getPrompt(name, args || {});
        return {
          description: prompt.description,
          messages: prompt.messages
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Prompt generation failed: ${errorMessage}`);
        
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Failed to generate prompt '${name}': ${errorMessage}`
        );
      }
    });

    // Error handling
    server.onerror = (error) => {
      this.logger.error('Server error:', error);
    };
  }

  private recordToolCall(name: string, result: unknown, durationMs: number): void {
    const success =
      !result ||
      typeof result !== 'object' ||
      (result as { success?: unknown }).success !== false;
    const input: TrackToolCallInput = {
      tool: name,
      success,
      durationMs
    };
    if (!success) {
      const summary = summarizeToolFailure(result);
      input.errorKind = summary.errorKind;
      if (summary.errorCode) input.errorCode = summary.errorCode;
      if (summary.errorFields) input.errorFields = summary.errorFields;
      if (summary.errorDetail) input.errorDetail = summary.errorDetail;
      if (summary.retry !== undefined) input.retry = summary.retry;
      if (summary.status) input.status = summary.status;
    }
    this.telemetry.trackToolCall(input);
  }

  async start(): Promise<void> {
    try {
      await this.bridge.initialize();
      this.logger.info('Adobe Premiere Pro bridge initialized');
      
      this.stdioHandle = serveStdio(() => this.buildServer(), {
        onerror: (error) => {
          this.logger.error('Stdio transport error:', error);
        }
      });
      
      this.logger.info('MCP Adobe Premiere Pro Server started successfully');
      this.telemetry.trackServerStarted();
      void checkForUpdate().then((status) => {
        if (status.available && !status.snoozed && status.nextStep) {
          this.logger.warn(status.nextStep);
        }
      });
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.stdioHandle?.close();
      await this.bridge.cleanup();
      this.logger.info('MCP Adobe Premiere Pro Server stopped');
    } catch (error) {
      this.logger.error('Error stopping server:', error);
      throw error;
    } finally {
      await this.telemetry.flush();
    }
  }
}

// Start the server
const server = new MCPPremiereProServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\nShutting down MCP Adobe Premiere Pro Server...');
  await server.stop();
  process.exit(0);
});

// Start the server
server.start().catch((error) => {
  console.error('Failed to start MCP Adobe Premiere Pro Server:', error);
  process.exit(1);
}); 
