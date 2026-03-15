#!/usr/bin/env node

// src/chat-bridge.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
function toLocalTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
var args = process.argv.slice(2);
var agentId = "";
var serverUrl = process.env.REDSHRIMP_SERVER_URL?.trim() || process.env.SERVER_URL?.trim() || `http://127.0.0.1:${process.env.PORT ?? 3001}`;
var authToken = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agent-id" && args[i + 1]) agentId = args[++i];
  if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
  if (args[i] === "--auth-token" && args[i + 1]) authToken = args[++i];
}
if (!agentId) {
  console.error("Missing --agent-id");
  process.exit(1);
}
var commonHeaders = { "Content-Type": "application/json" };
if (authToken) {
  commonHeaders["Authorization"] = `Bearer ${authToken}`;
}
var server = new McpServer({
  name: "chat",
  version: "1.0.0"
});
server.tool(
  "send_message",
  "Send a message to a channel or DM. To reply, reuse the channel value from the received message (e.g. channel='#all' or channel='DM:@richard'). To start a NEW DM, use dm_to with the person's name.",
  {
    channel: z.string().optional().describe(
      "Where to send. Reuse the identifier from received messages: '#channel-name' for channels, 'DM:@peer-name' for DMs. Examples: '#all', '#general', 'DM:@richard'."
    ),
    dm_to: z.string().optional().describe(
      "Person's name to start a NEW DM with (e.g. 'richard'). Only for starting a new DM \u2014 to reply in an existing DM, use channel instead."
    ),
    content: z.string().describe("The message content")
  },
  async ({ channel, dm_to, content }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/send`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, dm_to, content })
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [
            { type: "text", text: `Error: ${data.error}` }
          ]
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${channel || `new DM with ${dm_to}`}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "receive_message",
  "Receive new messages. Use block=true to wait for new messages. Returns messages formatted as [#channel-name] or [DM:@peer-name] followed by the sender and content.",
  {
    block: z.boolean().default(true).describe("Whether to block (wait) for new messages"),
    timeout_ms: z.number().default(45e3).describe("How long to wait in ms when blocking")
  },
  async ({ block, timeout_ms }) => {
    try {
      const params = new URLSearchParams();
      if (block) params.set("block", "true");
      params.set("timeout", String(timeout_ms));
      const res = await fetch(
        `${serverUrl}/internal/agent/${agentId}/receive?${params}`,
        { method: "GET", headers: commonHeaders }
      );
      const data = await res.json();
      if (!data.messages || data.messages.length === 0) {
        return {
          content: [{ type: "text", text: "No new messages." }]
        };
      }
      const formatted = data.messages.map((m) => {
        const channel = m.channel_type === "dm" ? `DM:@${m.channel_name}` : `#${m.channel_name}`;
        const senderPrefix = m.sender_type === "agent" ? "(agent) " : "";
        const time = m.timestamp ? ` (${toLocalTime(m.timestamp)})` : "";
        return `[${channel}]${time} ${senderPrefix}@${m.sender_name}: ${m.content}`;
      }).join("\n");
      return {
        content: [{ type: "text", text: formatted }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "list_server",
  "List all channels in this server, including which ones you have joined, plus all agents and humans. Use this to discover who and where you can message.",
  {},
  async () => {
    try {
      const res = await fetch(
        `${serverUrl}/internal/agent/${agentId}/server`,
        { method: "GET", headers: commonHeaders }
      );
      const data = await res.json();
      let text = "## Server\n\n";
      text += "### Channels\n";
      text += "Use `#channel-name` with send_message to post in a channel. `joined` means you currently belong to that channel.\n";
      if (data.channels?.length > 0) {
        for (const t of data.channels) {
          const status = t.joined ? "joined" : "not joined";
          text += t.description ? `  - #${t.name} [${status}] \u2014 ${t.description}
` : `  - #${t.name} [${status}]
`;
        }
      } else {
        text += "  (none)\n";
      }
      text += "\n### Agents\n";
      text += "Other AI agents in this server.\n";
      if (data.agents?.length > 0) {
        for (const a of data.agents) {
          text += `  - @${a.name} (${a.status})
`;
        }
      } else {
        text += "  (none)\n";
      }
      text += "\n### Humans\n";
      text += 'To start a new DM: send_message(dm_to="<name>"). To reply in an existing DM: reuse channel from the received message.\n';
      if (data.humans?.length > 0) {
        for (const u of data.humans) {
          text += `  - @${u.name}
`;
        }
      } else {
        text += "  (none)\n";
      }
      return {
        content: [{ type: "text", text }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "read_history",
  "Read message history for a channel or DM. Use #channel-name for channels or DM:@name for DMs. Supports pagination: use 'before' to load older messages, 'after' to load messages after a seq number (e.g. to catch up on unread).",
  {
    channel: z.string().describe("The channel to read history from \u2014 e.g. '#all', '#general', 'DM:@richard'"),
    limit: z.number().default(50).describe("Max number of messages to return (default 50, max 100)"),
    before: z.number().optional().describe("Return messages before this seq number (for backward pagination). Omit for latest messages."),
    after: z.number().optional().describe("Return messages after this seq number (for catching up on unread). Returns oldest-first.")
  },
  async ({ channel, limit, before, after }) => {
    try {
      const params = new URLSearchParams();
      params.set("channel", channel);
      params.set("limit", String(Math.min(limit, 100)));
      if (before) params.set("before", String(before));
      if (after) params.set("after", String(after));
      const res = await fetch(
        `${serverUrl}/internal/agent/${agentId}/history?${params}`,
        { method: "GET", headers: commonHeaders }
      );
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [
            { type: "text", text: `Error: ${data.error}` }
          ]
        };
      }
      if (!data.messages || data.messages.length === 0) {
        return {
          content: [
            { type: "text", text: "No messages in this channel." }
          ]
        };
      }
      const formatted = data.messages.map((m) => {
        const senderPrefix = m.senderType === "agent" ? "(agent) " : "";
        const time = m.createdAt ? ` (${toLocalTime(m.createdAt)})` : "";
        return `[seq:${m.seq}]${time} ${senderPrefix}@${m.senderName}: ${m.content}`;
      }).join("\n");
      let footer = "";
      if (data.historyLimited) {
        footer = `

--- ${data.historyLimitMessage || "Message history is limited on this plan."} ---`;
      } else if (data.has_more && data.messages.length > 0) {
        if (after) {
          const maxSeq = data.messages[data.messages.length - 1].seq;
          footer = `

--- ${data.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`;
        } else {
          const minSeq = data.messages[0].seq;
          footer = `

--- ${data.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`;
        }
      }
      let header = `## Message History for ${channel} (${data.messages.length} messages)`;
      if (data.last_read_seq > 0 && !after && !before) {
        header += `
Your last read position: seq ${data.last_read_seq}. Use read_history(channel="${channel}", after=${data.last_read_seq}) to see only unread messages.`;
      }
      return {
        content: [
          {
            type: "text",
            text: `${header}

${formatted}${footer}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "create_todo_bundle",
  "Create a todo root in memory/todos/<todo>/index.md, create the parent task plus subtasks, and link the root markdown to that todo.",
  {
    channel: z.string().describe("Target channel, e.g. '#all'"),
    title: z.string().describe("Parent todo title"),
    summary: z.string().optional().describe("Summary of the todo"),
    owner_agent_id: z.string().optional().describe("Primary owner agent id or name/mention. Defaults to the calling agent if omitted."),
    clean_level: z.string().optional().describe("Current user-agreed memory cleanliness standard"),
    subtasks: z.array(
      z.object({
        title: z.string().describe("Subtask title"),
        assignee_agent_id: z.string().optional().describe("Assignee agent id or name/mention")
      })
    ).default([]).describe("Subtasks to create under the todo")
  },
  async ({ channel, title, summary, owner_agent_id, clean_level, subtasks }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/todo-intake`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, title, summary, owner_agent_id, clean_level, subtasks })
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      }
      const subtasksLine = data.bundle.subtaskNumbers.length > 0
        ? data.bundle.subtaskNumbers.map((n) => `#t${n}`).join(", ")
        : "none";
      return {
        content: [{
          type: "text",
          text: `Todo bundle created in ${channel}

Parent: #t${data.bundle.parentTaskNumber}
Subtasks: ${subtasksLine}
Root memory: ${data.bundle.docPath}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);
server.tool(
  "append_todo_note",
  "Append a derived markdown note to the current todo. Use this for plans, summaries, reading notes, or review notes so every derived markdown stays under the same todo. If task_id is omitted, the server will try to use the agent's current active task automatically.",
  {
    task_id: z.string().optional().describe("The parent todo task id. Optional if the agent currently has exactly one active task."),
    title: z.string().describe("Markdown note title"),
    content: z.string().describe("Markdown note content")
  },
  async ({ task_id, title, content }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks/memory-note`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ task_id, title, content })
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `Todo note linked to #t${data.task.number}: ${data.note.docPath}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);
server.tool(
  "list_tasks",
  "List tasks on a channel's task board. Returns tasks with their number (#t1, #t2...), title, status, and assignee.",
  {
    channel: z.string().describe("The channel whose task board to view \u2014 e.g. '#engineering', '#proj-slock'"),
    status: z.enum(["all", "todo", "in_progress", "in_review", "done"]).default("all").describe("Filter by status (default: all)")
  },
  async ({ channel, status }) => {
    try {
      const params = new URLSearchParams();
      params.set("channel", channel);
      if (status !== "all") params.set("status", status);
      const res = await fetch(
        `${serverUrl}/internal/agent/${agentId}/tasks?${params}`,
        { method: "GET", headers: commonHeaders }
      );
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }]
        };
      }
      if (!data.tasks || data.tasks.length === 0) {
        return {
          content: [{ type: "text", text: `No${status !== "all" ? ` ${status}` : ""} tasks in ${channel}.` }]
        };
      }
      const formatted = data.tasks.map((t) => {
        const assignee = t.claimedByName ? ` \u2192 @${t.claimedByName}` : "";
        const creator = t.createdByName ? ` (by @${t.createdByName})` : "";
        return `#t${t.taskNumber} [${t.status}] "${t.title}"${assignee}${creator}`;
      }).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `## Task Board for ${channel} (${data.tasks.length} tasks)

${formatted}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "create_tasks",
  "Create one or more tasks on a channel's task board. Tasks are assigned immediately when created. If assignee_agent_id is omitted, the task is assigned to the calling agent. The assignee can be given as agent id, plain name, or @mention.",
  {
    channel: z.string().describe("The channel to create tasks in \u2014 e.g. '#engineering'"),
    tasks: z.array(
      z.object({
        title: z.string().describe("Task title"),
        assignee_agent_id: z.string().optional().describe("Explicit assignee agent id, plain name, or @mention. Defaults to the calling agent if omitted.")
      })
    ).describe("Array of tasks to create")
  },
  async ({ channel, tasks }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/tasks`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, tasks })
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }]
        };
      }
      const created = data.tasks
        .map((t) => `#t${t.taskNumber} "${t.title}"${t.assigneeName ? ` \u2192 @${t.assigneeName}` : ""}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Created ${data.tasks.length} task(s) in ${channel}:
${created}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "create_task_room",
  "Create or reopen a task-specific group channel and invite the relevant members. Useful when Donovan or Brandeis need a dedicated room for a task discussion.",
  {
    channel: z.string().describe("The parent task-board channel that owns the task — e.g. '#all'"),
    task_number: z.number().describe("The task number to create a room for (e.g. 138)"),
    participant_agent_ids: z.array(z.string()).optional().describe("Optional extra agent ids, plain names, or @mentions to invite into the room.")
  },
  async ({ channel, task_number, participant_agent_ids }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/task-room`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ channel, task_number, participant_agent_ids })
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }]
        };
      }
      const invitedAgents = data.invitedAgents?.length
        ? `Agents: ${data.invitedAgents.map((name) => `@${name}`).join(", ")}`
        : "Agents: none";
      const invitedHumans = `Humans inherited from ${channel}: ${data.invitedHumans ?? 0}`;
      return {
        content: [{
          type: "text",
          text: `${data.created ? "Created" : "Reopened"} task room #${data.channel.name} for #t${task_number}.\n${invitedAgents}\n${invitedHumans}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "claim_tasks",
  "Disabled in explicit-assignment mode. Tasks must be assigned by a human reviewer.",
  {
    channel: z.string().describe("The channel whose tasks to claim \u2014 e.g. '#engineering'"),
    task_numbers: z.array(z.number()).describe("Task numbers to claim (e.g. [1, 3, 5])")
  },
  async () => {
    return {
      content: [{
        type: "text",
        text: "Error: Tasks must be explicitly assigned by a human. claim_tasks is disabled."
      }]
    };
  }
);
server.tool(
  "unclaim_task",
  "Disabled in explicit-assignment mode. Assigned tasks cannot be unclaimed by agents.",
  {
    channel: z.string().describe("The channel \u2014 e.g. '#engineering'"),
    task_number: z.number().describe("The task number to unclaim (e.g. 3)")
  },
  async () => {
    return {
      content: [{
        type: "text",
        text: "Error: Tasks must be explicitly assigned by a human. unclaim_task is disabled."
      }]
    };
  }
);
server.tool(
  "update_task_status",
  "Update task progress status for a task already assigned to you. Valid transitions: todo\u2192in_progress, in_progress\u2192in_review, in_progress\u2192done, in_review\u2192in_progress, in_review\u2192done.",
  {
    channel: z.string().describe("The channel \u2014 e.g. '#engineering'"),
    task_number: z.number().describe("The task number to update (e.g. 3)"),
    status: z.enum(["todo", "in_progress", "in_review", "done"]).describe("The new status")
  },
  async ({ channel, task_number, status }) => {
    try {
      const res = await fetch(
        `${serverUrl}/internal/agent/${agentId}/tasks/update-status`,
        {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify({ channel, task_number, status })
        }
      );
      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error}` }]
        };
      }
      return {
        content: [
          { type: "text", text: `#t${task_number} moved to ${status}.` }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);
server.tool(
  "create_bulletin",
  "Create a bulletin (便签/公告). The bulletin is saved to the board and also written as a flash note in the vault. Use category 'sticky' for personal notes, 'chrono' for timeline updates, 'ops' for operational status, 'report' for reports, 'announcement' for announcements.",
  {
    category: z.enum(["sticky", "chrono", "ops", "report", "announcement"]).describe("Bulletin category"),
    title: z.string().describe("Bulletin title"),
    content: z.string().optional().describe("Bulletin body content (markdown supported)"),
    priority: z.enum(["urgent", "normal", "low"]).default("normal").describe("Priority level"),
    linked_url: z.string().optional().describe("Optional external link"),
    pinned: z.boolean().default(false).describe("Whether to pin the bulletin"),
  },
  async ({ category, title, content, priority, linked_url, pinned }) => {
    try {
      const res = await fetch(`${serverUrl}/internal/agent/${agentId}/bulletins`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ category, title, content, priority, linked_url, pinned })
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      }
      const b = data.bulletin;
      let text = `Bulletin created: "${b.title}" [${b.category}]`;
      if (b.linked_file) text += `\nVault flash note: ${b.linked_file}`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);
// Gracefully handle EPIPE when parent process is killed
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});
process.stdin.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

var transport = new StdioServerTransport();
await server.connect(transport);
