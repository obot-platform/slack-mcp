#!/usr/bin/env node

import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import Fuse from "fuse.js";
import slackifyMarkdown from "slackify-markdown";

// Schema definitions for all tools
const ListChannelsSchema = z.object({});

const SearchChannelsSchema = z.object({
  query: z.string().describe("The search query for channels"),
});

const AddUserToChannelSchema = z.object({
  channelId: z.string().describe("The ID of the channel to add the user to"),
  userId: z.string().describe("The ID of the user to add to the channel"),
});

const GetChannelHistorySchema = z.object({
  channelId: z
    .string()
    .describe("The ID of the channel to get the history for"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The number of messages to return"),
});

const GetChannelHistoryByTimeSchema = z.object({
  channelId: z
    .string()
    .describe("The ID of the channel to get the history for"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The maximum number of messages to return"),
  start: z.string().describe("The start time in RFC 3339 format"),
  end: z.string().describe("The end time in RFC 3339 format"),
});

const GetThreadHistorySchema = z.object({
  channelId: z.string().describe("The ID of the channel containing the thread"),
  threadId: z.string().describe("The ID of the thread to get the history for"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The number of messages to return"),
});

const GetThreadHistoryFromLinkSchema = z.object({
  messageLink: z
    .string()
    .describe("The link to the first Slack message in the thread"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The number of messages to return"),
});

const SearchMessagesSchema = z.object({
  query: z.string().describe("The search query"),
  sortByTime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Sort by timestamp rather than score"),
});

const SendMessageSchema = z.object({
  channelId: z
    .string()
    .describe("The ID of the channel to send the message to"),
  text: z.string().describe("The text to send"),
});

const SendMessageInThreadSchema = z.object({
  channelId: z.string().describe("The ID of the channel containing the thread"),
  threadId: z.string().describe("The ID of the thread to send the message to"),
  text: z.string().describe("The text to send"),
});

const ListUsersSchema = z.object({});

const SearchUsersSchema = z.object({
  query: z.string().describe("The search query for users"),
});

const SendDMSchema = z.object({
  userIds: z
    .string()
    .describe("Comma-separated list of user IDs to send the message to"),
  text: z.string().describe("The text to send"),
});

const SendDMInThreadSchema = z.object({
  userIds: z
    .string()
    .describe("Comma-separated list of user IDs for the conversation"),
  threadId: z.string().describe("The ID of the thread to send the message to"),
  text: z.string().describe("The text to send"),
});

const GetMessageLinkSchema = z.object({
  channelId: z
    .string()
    .describe("The ID of the channel containing the message"),
  messageId: z.string().describe("The ID of the message"),
});

const GetDMHistorySchema = z.object({
  userIds: z
    .string()
    .describe("Comma-separated list of user IDs for the conversation"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The number of messages to return"),
});

const GetDMThreadHistorySchema = z.object({
  userIds: z
    .string()
    .describe("Comma-separated list of user IDs for the conversation"),
  threadId: z.string().describe("The ID of the thread to get the history for"),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("The number of messages to return"),
});

const UserContextSchema = z.object({});

const SendTypingEventSchema = z.object({
  channelId: z
    .string()
    .describe("The ID of the channel to send the typing event to"),
  threadId: z
    .string()
    .optional()
    .describe("The ID of the thread to send the typing event to"),
  status: z
    .string()
    .describe(
      "The status to set the typing event that shows in the slack thread",
    ),
});

// Pass Zod schemas through without triggering deep type inference.
const toolSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => schema;


// Helpful inferred types to reduce inference pressure at call sites
type ListChannelsArgs = Record<string, never>;
type SearchChannelsArgs = { query: string };
type AddUserToChannelArgs = { channelId: string; userId: string };
type GetChannelHistoryArgs = { channelId: string; limit: number };
type GetChannelHistoryByTimeArgs = {
  channelId: string;
  limit: number;
  start: string;
  end: string;
};
type GetThreadHistoryArgs = {
  channelId: string;
  threadId: string;
  limit: number;
};
type GetThreadHistoryFromLinkArgs = { messageLink: string; limit: number };
type SearchMessagesArgs = { query: string; sortByTime: boolean };
type SendMessageArgs = { channelId: string; text: string };
type SendMessageInThreadArgs = {
  channelId: string;
  threadId: string;
  text: string;
};
type ListUsersArgs = Record<string, never>;
type SearchUsersArgs = { query: string };
type SendDMArgs = { userIds: string; text: string };
type SendDMInThreadArgs = {
  userIds: string;
  threadId: string;
  text: string;
};
type GetMessageLinkArgs = { channelId: string; messageId: string };
type GetDMHistoryArgs = { userIds: string; limit: number };
type GetDMThreadHistoryArgs = {
  userIds: string;
  threadId: string;
  limit: number;
};
type UserContextArgs = Record<string, never>;
type SendTypingEventArgs = {
  channelId: string;
  threadId?: string;
  status: string;
};


class SlackClient {
  private webClient: WebClient;

  constructor(botToken: string) {
    this.webClient = new WebClient(botToken);
  }

  async userContext() {
    const result = await this.webClient.auth.test({});
    const userResult = await this.webClient.users.info({
      user: result.user_id!,
    });
    return {
      name: userResult.user?.name || "",
      realName: userResult.user?.profile?.real_name || "",
      displayName: userResult.user?.profile?.display_name || "",
      userId: result.user_id || "",
    };
  }

  async listChannels() {
    let allChannels: any[] = [];
    let cursor;
    do {
      const result = await this.webClient.conversations.list({
        limit: 100,
        types: "public_channel,private_channel",
        cursor: cursor,
      });
      if (result.channels) {
        allChannels = allChannels.concat(result.channels);
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    return allChannels;
  }

  async searchChannels(query: string) {
    const allChannels = await this.listChannels();
    const fuse = new Fuse(allChannels, {
      keys: ["name"],
      threshold: 0.4,
      findAllMatches: true,
    });
    return fuse.search(query).map((result) => result.item);
  }

  async addUserToChannel(channelId: string, userId: string) {
    await this.webClient.conversations.invite({
      channel: channelId,
      users: userId,
    });
  }

  async getChannelHistory(channelId: string, limit: number = 10) {
    const history = await this.webClient.conversations.history({
      channel: channelId,
      limit: limit,
    });
    return history.messages ?? [];
  }

  async getChannelHistoryByTime(
    channelId: string,
    limit: number,
    start: string,
    end: string,
  ) {
    const oldest = new Date(start).getTime() / 1000;
    const latest = new Date(end).getTime() / 1000;
    const history = await this.webClient.conversations.history({
      channel: channelId,
      limit: limit,
      oldest: oldest.toString(),
      latest: latest.toString(),
    });
    return history.messages ?? [];
  }

  async getThreadHistory(
    channelId: string,
    threadId: string,
    limit: number = 10,
  ) {
    const replies = await this.webClient.conversations.replies({
      channel: channelId,
      ts: threadId,
      limit: limit,
    });
    return replies.messages ?? [];
  }

  async getThreadHistoryFromLink(messageLink: string, limit: number = 10) {
    const matches = messageLink.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
    if (!matches) {
      throw new Error("Invalid message link format");
    }

    const channelId = matches[1];
    const threadId = matches[2].slice(0, -6) + "." + matches[2].slice(-6);
    return await this.getThreadHistory(channelId, threadId, limit);
  }

  async searchMessages(query: string, sortByTime: boolean = false) {
    const result = await this.webClient.search.all({
      query: query,
      sort: sortByTime ? "timestamp" : "score",
    });
    return result.messages?.matches ?? [];
  }

  removeBoldInHeadings(markdownText: string) {
    return markdownText
      .split("\n")
      .map((line) => {
        const headingMatch = line.match(/^(\s{0,3}#+\s)(.*)$/);
        if (headingMatch) {
          const prefix = headingMatch[1];
          let content = headingMatch[2];
          content = content.replace(/\*\*(.+?)\*\*/g, "$1");
          content = content.replace(/__(.+?)__/g, "$1");
          return prefix + content;
        }
        return line;
      })
      .join("\n");
  }

  markdownToSlack(text: string) {
    text = this.removeBoldInHeadings(text);
    return slackifyMarkdown(text);
  }

  async sendMessage(channelId: string, text: string) {
    const result = await this.webClient.chat.postMessage({
      channel: channelId,
      text: this.markdownToSlack(text),
    });
    return result;
  }

  async sendMessageInThread(channelId: string, threadId: string, text: string) {
    const result = await this.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: this.markdownToSlack(text),
    });
    return result;
  }

  async listUsers() {
    let allUsers: any[] = [];
    let cursor;
    do {
      const result = await this.webClient.users.list({
        limit: 100,
        cursor: cursor,
      });
      if (result.members) {
        allUsers = allUsers.concat(result.members);
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    return allUsers;
  }

  async searchUsers(query: string) {
    const allUsers = await this.listUsers();
    const fuse = new Fuse(allUsers, {
      keys: ["name", "real_name", "profile.display_name"],
      threshold: 0.4,
      findAllMatches: true,
    });
    return fuse.search(query).map((result) => result.item);
  }

  async sendDM(userIds: string, text: string) {
    const userIdArray = userIds.split(",").map((id) => id.trim());
    const result = await this.webClient.conversations.open({
      users: userIdArray.join(","),
    });

    if (!result.ok || !result.channel) {
      throw new Error(`Failed to open DM: ${result.error}`);
    }

    const messageResult = await this.webClient.chat.postMessage({
      channel: result.channel?.id || "",
      text: this.markdownToSlack(text),
    });
    return messageResult;
  }

  async sendDMInThread(userIds: string, threadId: string, text: string) {
    const userIdArray = userIds.split(",").map((id) => id.trim());
    const result = await this.webClient.conversations.open({
      users: userIdArray.join(","),
    });

    if (!result.ok || !result.channel) {
      throw new Error(`Failed to open DM: ${result.error}`);
    }

    const messageResult = await this.webClient.chat.postMessage({
      channel: result.channel?.id || "",
      thread_ts: threadId,
      text: this.markdownToSlack(text),
    });
    return messageResult;
  }

  async getMessageLink(channelId: string, messageId: string) {
    const result = await this.webClient.chat.getPermalink({
      channel: channelId,
      message_ts: messageId,
    });
    return result.permalink;
  }

  async getDMHistory(userIds: string, limit: number = 10) {
    const userIdArray = userIds.split(",").map((id) => id.trim());
    const result = await this.webClient.conversations.open({
      users: userIdArray.join(","),
    });

    if (!result.ok || !result.channel) {
      throw new Error(`Failed to open DM: ${result.error}`);
    }

    const history = await this.webClient.conversations.history({
      channel: result.channel?.id || "",
      limit: limit,
    });
    return history.messages ?? [];
  }

  async getDMThreadHistory(
    userIds: string,
    threadId: string,
    limit: number = 10,
  ) {
    const userIdArray = userIds.split(",").map((id) => id.trim());
    const result = await this.webClient.conversations.open({
      users: userIdArray.join(","),
    });

    if (!result.ok || !result.channel) {
      throw new Error(`Failed to open DM: ${result.error}`);
    }

    const replies = await this.webClient.conversations.replies({
      channel: result.channel?.id || "",
      ts: threadId,
      limit: limit,
    });
    return replies.messages ?? [];
  }

  async sendTypingEvent(channelId: string, threadId?: string, status?: string) {
    await this.webClient.assistant.threads.setStatus({
      thread_ts: threadId || "",
      channel_id: channelId,
      status: status || "is typing...",
    });
  }
}

// Create MCP server using the SDK
function createMcpServer(slackClient: SlackClient, token: string): McpServer {
  const server = new McpServer(
    {
      name: "slack-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register tools without forcing TypeScript to deeply infer Zod schema types.
  const registerTool = (
    name: string,
    definition: Record<string, unknown>,
    handler: (args: any) => Promise<CallToolResult>,
  ) => {
    return (server as any).registerTool(name, definition, handler);
  };

  const isBotToken = token.startsWith("xoxb-");

  registerTool(
    "list_channels",
    {
      description:
        "List all channels in the Slack workspace. Returns the name and ID for each channel",
      inputSchema: toolSchema(ListChannelsSchema),
    },
    async (_args: ListChannelsArgs): Promise<CallToolResult> => {
      const channels = await slackClient.listChannels();
      return {
        structuredContent: { channels },
        content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
      };
    },
  );

  registerTool(
    "search_channels",
    {
      description: "Search for channels in the Slack workspace",
      inputSchema: toolSchema(SearchChannelsSchema),
    },
    async (args: SearchChannelsArgs): Promise<CallToolResult> => {
      const channels = await slackClient.searchChannels(args.query);
      return {
        structuredContent: { channels },
        content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
      };
    },
  );

  registerTool(
    "add_user_to_channel",
    {
      description: "Add a user to a channel in the Slack workspace",
      inputSchema: toolSchema(AddUserToChannelSchema),
    },
    async (args: AddUserToChannelArgs): Promise<CallToolResult> => {
      try {
        await slackClient.addUserToChannel(args.channelId, args.userId);
      } catch (error) {
        if ((error as any)?.data?.error !== "already_in_channel") {
          throw error;
        }
      }

      return {
        structuredContent: {
          channelId: args.channelId,
          userId: args.userId,
          status: "added_or_already_in_channel",
        },
        content: [
          {
            type: "text",
            text: `User ${args.userId} added to channel ${args.channelId}`,
          },
        ],
      };
    },
  );

  registerTool(
    "get_channel_history",
    {
      description: "Get the chat history for a channel in the Slack workspace",
      inputSchema: toolSchema(GetChannelHistorySchema),
    },
    async (args: GetChannelHistoryArgs): Promise<CallToolResult> => {
      const messages = await slackClient.getChannelHistory(
        args.channelId,
        args.limit,
      );
      return {
        structuredContent: { messages },
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  registerTool(
    "get_channel_history_by_time",
    {
      description:
        "Get the chat history for a channel in the Slack workspace within a specific time range",
      inputSchema: toolSchema(GetChannelHistoryByTimeSchema),
    },
    async (args: GetChannelHistoryByTimeArgs): Promise<CallToolResult> => {
      const messages = await slackClient.getChannelHistoryByTime(
        args.channelId,
        args.limit,
        args.start,
        args.end,
      );
      return {
        structuredContent: { messages },
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  registerTool(
    "get_thread_history",
    {
      description: "Get the chat history for a particular thread",
      inputSchema: toolSchema(GetThreadHistorySchema),
    },
    async (args: GetThreadHistoryArgs): Promise<CallToolResult> => {
      const messages = await slackClient.getThreadHistory(
        args.channelId,
        args.threadId,
        args.limit,
      );
      return {
        structuredContent: { messages },
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  registerTool(
    "get_thread_history_from_link",
    {
      description:
        "Get the chat history for a particular thread from a Slack message link",
      inputSchema: toolSchema(GetThreadHistoryFromLinkSchema),
    },
    async (args: GetThreadHistoryFromLinkArgs): Promise<CallToolResult> => {
      const messages = await slackClient.getThreadHistoryFromLink(
        args.messageLink,
        args.limit,
      );
      return {
        structuredContent: { messages },
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    },
  );

  if (!isBotToken) {
    registerTool(
      "search_messages",
      {
        description: "Search for messages in the Slack workspace",
        inputSchema: toolSchema(SearchMessagesSchema),
      },
      async (args: SearchMessagesArgs): Promise<CallToolResult> => {
        const messages = await slackClient.searchMessages(
          args.query,
          args.sortByTime,
        );
        return {
          structuredContent: { messages },
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      },
    );

    registerTool(
      "get_dm_history",
      {
        description: "Get the chat history for a direct message conversation",
        inputSchema: toolSchema(GetDMHistorySchema),
      },
      async (args: GetDMHistoryArgs): Promise<CallToolResult> => {
        const messages = await slackClient.getDMHistory(args.userIds, args.limit);
        return {
          structuredContent: { messages },
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      },
    );

    registerTool(
      "get_dm_thread_history",
      {
        description:
          "Get the chat history for a thread in a direct message conversation",
        inputSchema: toolSchema(GetDMThreadHistorySchema),
      },
      async (args: GetDMThreadHistoryArgs): Promise<CallToolResult> => {
        const messages = await slackClient.getDMThreadHistory(
          args.userIds,
          args.threadId,
          args.limit,
        );
        return {
          structuredContent: { messages },
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      },
    );
  }

  registerTool(
    "send_message",
    {
      description: "Send a message to a channel in the Slack workspace",
      inputSchema: toolSchema(SendMessageSchema),
    },
    async (args: SendMessageArgs): Promise<CallToolResult> => {
      const result = await slackClient.sendMessage(args.channelId, args.text);
      return {
        structuredContent: { result },
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  registerTool(
    "send_message_in_thread",
    {
      description: "Send a message in a thread in the Slack workspace",
      inputSchema: toolSchema(SendMessageInThreadSchema),
    },
    async (args: SendMessageInThreadArgs): Promise<CallToolResult> => {
      const result = await slackClient.sendMessageInThread(
        args.channelId,
        args.threadId,
        args.text,
      );
      return {
        structuredContent: { result },
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  registerTool(
    "list_users",
    {
      description: "List all users in the Slack workspace",
      inputSchema: toolSchema(ListUsersSchema),
    },
    async (_args: ListUsersArgs): Promise<CallToolResult> => {
      const users = await slackClient.listUsers();
      return {
        structuredContent: { users },
        content: [{ type: "text", text: JSON.stringify(users, null, 2) }],
      };
    },
  );

  registerTool(
    "search_users",
    {
      description: "Search for users in the Slack workspace",
      inputSchema: toolSchema(SearchUsersSchema),
    },
    async (args: SearchUsersArgs): Promise<CallToolResult> => {
      const users = await slackClient.searchUsers(args.query);
      return {
        structuredContent: { users },
        content: [{ type: "text", text: JSON.stringify(users, null, 2) }],
      };
    },
  );

  registerTool(
    "send_dm",
    {
      description: "Send a direct message to a user",
      inputSchema: toolSchema(SendDMSchema),
    },
    async (args: SendDMArgs): Promise<CallToolResult> => {
      const result = await slackClient.sendDM(args.userIds, args.text);
      return {
        structuredContent: { result },
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  registerTool(
    "send_dm_in_thread",
    {
      description:
        "Send a message in a thread in a direct message conversation",
      inputSchema: toolSchema(SendDMInThreadSchema),
    },
    async (args: SendDMInThreadArgs): Promise<CallToolResult> => {
      const result = await slackClient.sendDMInThread(
        args.userIds,
        args.threadId,
        args.text,
      );
      return {
        structuredContent: { result },
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  registerTool(
    "get_message_link",
    {
      description: "Get the permalink for a message",
      inputSchema: toolSchema(GetMessageLinkSchema),
    },
    async (args: GetMessageLinkArgs): Promise<CallToolResult> => {
      const link = await slackClient.getMessageLink(
        args.channelId,
        args.messageId,
      );
      return {
        structuredContent: { link },
        content: [{ type: "text", text: JSON.stringify({ link }, null, 2) }],
      };
    },
  );

  registerTool(
    "user_context",
    {
      description: "Get information about the logged in user",
      inputSchema: toolSchema(UserContextSchema),
    },
    async (_args: UserContextArgs): Promise<CallToolResult> => {
      const userInfo = await slackClient.userContext();
      return {
        structuredContent: { userInfo },
        content: [{ type: "text", text: JSON.stringify(userInfo, null, 2) }],
      };
    },
  );

  registerTool(
    "send_typing_event",
    {
      description: "Send a typing event to a channel in the Slack workspace",
      inputSchema: toolSchema(SendTypingEventSchema),
    },
    async (args: SendTypingEventArgs): Promise<CallToolResult> => {
      await slackClient.sendTypingEvent(args.channelId, args.threadId, args.status);
      return {
        structuredContent: {
          channelId: args.channelId,
          threadId: args.threadId ?? null,
          status: args.status,
          ok: true,
        },
        content: [{ type: "text", text: "Typing event sent" }],
      };
    },
  );

  return server;
}

async function getServer() {
  try {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      throw new Error("SLACK_BOT_TOKEN is not set");
    }

    const slackClient = new SlackClient(botToken);
    const mcpServer = createMcpServer(slackClient, botToken);
    return mcpServer;
  } catch (error) {
    console.error("Failed to initialize server:", error);
    process.exit(1);
  }
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req: Request, res: Response) => {
  console.log(req.headers);
  const server = await getServer();
  try {
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (_req: Request, res: Response) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

app.delete("/mcp", async (_req: Request, res: Response) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, () => {
  console.log(
    `Slack MCP Stateless Streamable HTTP Server listening on port ${PORT}`,
  );
});

// Handle server shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  process.exit(0);
});

