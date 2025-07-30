// KeywordEmailNotifier.js
// Vencord plugin that watches for keywords in Discord messages and emails you with details.
// Features:
// - Global & per-server enable toggles
// - Per-server & default keyword lists
// - Channel filtering
// - User whitelist
// - Ignore bots option
// - Rate limiting & cooldown per keyword
// - Multi-email support
// - Test email button
// - Beginner-friendly setting descriptions

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

module.exports = {
  name: "KeywordEmailNotifier",
  description:
    "Notifies you by email when specified keywords appear in Discord messages, with flexible per-server and global settings.",
  authors: ["YourName"],

  settings: {
    globalEnabled: {
      type: "boolean",
      default: true,
      description:
        "Turn this ON to monitor messages in all allowed servers. Turn OFF to pause monitoring everywhere.",
    },
    allowedServers: {
      type: "array",
      default: [],
      description:
        "Select which Discord servers to watch. Messages outside these servers won’t trigger alerts.",
    },
    defaultKeywords: {
      type: "array",
      default: ["alert", "emergency"],
      description:
        "Keywords to watch for if there are no server-specific keyword lists set.",
    },
    perServerKeywords: {
      type: "object",
      default: {},
      description:
        "Set different keywords for each server. Format: { serverId: ['word1', 'word2'] }",
    },
    allowedChannels: {
      type: "array",
      default: [],
      description:
        "Optionally, monitor only these specific text channels. Leave empty to watch all channels.",
    },
    ignoreBots: {
      type: "boolean",
      default: true,
      description: "If ON, messages sent by bots will be ignored.",
    },
    userWhitelist: {
      type: "array",
      default: [],
      description:
        "Only watch messages from these user IDs. Leave empty to watch all users.",
    },
    rateLimitPerMinute: {
      type: "number",
      default: 5,
      description:
        "Maximum number of emails sent per minute to avoid flooding your inbox.",
    },
    cooldownSeconds: {
      type: "number",
      default: 30,
      description:
        "Minimum seconds to wait before sending another email for the same keyword.",
    },
    multiEmailRecipients: {
      type: "array",
      default: [],
      description:
        "Add multiple email addresses to receive alerts (separate each email).",
    },
    sendGridApiKey: {
      type: "string",
      default: "",
      description:
        "Your SendGrid API key for sending emails. Keep it secret and safe.",
      sensitive: true,
    },
    senderEmailAddress: {
      type: "string",
      default: "notifier@plugin.com",
      description:
        "The email address shown as sender in notification emails.",
    },
  },

  start() {
    this.emailLog = [];
    this.lastSent = {}; // Track last sent times per keyword+server combo
    this.messageHandler = this.handleMessage.bind(this);

    VencordApi.on("MESSAGE_CREATE", this.messageHandler);
  },

  stop() {
    VencordApi.off("MESSAGE_CREATE", this.messageHandler);
  },

  async handleMessage(message) {
    try {
      if (!this.settings.globalEnabled) return;
      if (!message.guild_id) return; // Not in a server

      const serverId = message.guild_id;
      if (
        this.settings.allowedServers.length > 0 &&
        !this.settings.allowedServers.includes(serverId)
      )
        return;

      if (
        this.settings.allowedChannels.length > 0 &&
        !this.settings.allowedChannels.includes(message.channel_id)
      )
        return;

      if (this.settings.ignoreBots && message.author?.bot) return;

      if (
        this.settings.userWhitelist.length > 0 &&
        !this.settings.userWhitelist.includes(message.author?.id)
      )
        return;

      const content = message.content?.toLowerCase();
      if (!content) return;

      // Choose keywords for this server or fallback to default
      const keywords =
        this.settings.perServerKeywords[serverId] ||
        this.settings.defaultKeywords;

      for (const word of keywords) {
        if (!word) continue;
        if (content.includes(word.toLowerCase())) {
          // Rate limiting & cooldown check
          const now = Date.now();
          const key = `${serverId}-${word.toLowerCase()}`;

          // Remove old entries from emailLog (over 1 min ago)
          this.emailLog = this.emailLog.filter(
            (t) => now - t < 60 * 1000
          );
          if (this.emailLog.length >= this.settings.rateLimitPerMinute)
            return;

          // Cooldown check
          if (
            this.lastSent[key] &&
            now - this.lastSent[key] < this.settings.cooldownSeconds * 1000
          )
            return;

          this.lastSent[key] = now;
          this.emailLog.push(now);

          // Send email notification
          this.sendEmailNotification(word, message);
          break;
        }
      }
    } catch (e) {
      console.error("KeywordEmailNotifier error:", e);
    }
  },

  async sendEmailNotification(keyword, message) {
    if (
      !this.settings.sendGridApiKey ||
      !this.settings.senderEmailAddress ||
      (this.settings.multiEmailRecipients.length === 0 &&
        this.settings.sendGridApiKey === "")
    )
      return;

    const subject = `Keyword Detected: "${keyword}" in ${message.guild_id}`;
    const timestamp = new Date(message.timestamp || Date.now()).toLocaleString();

    const serverName = VencordApi.getGuildName(message.guild_id) || "Unknown Server";
    const channelName =
      VencordApi.getChannelName(message.channel_id) || "Unknown Channel";

    const authorName = message.author?.username || "Unknown User";
    const authorTag = message.author
      ? `${message.author.username}#${message.author.discriminator}`
      : "Unknown User";

    const messageUrl = `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`;

    const emailContent = `
Keyword: ${keyword}
Server: ${serverName}
Channel: ${channelName}
User: ${authorTag}
Time: ${timestamp}

Message:
${message.content}

Link to message: ${messageUrl}
`;

    // Prepare recipients list
    let recipients = this.settings.multiEmailRecipients;
    // If no recipients but API key is set, send to senderEmailAddress itself
    if (recipients.length === 0) {
      recipients = [this.settings.senderEmailAddress];
    }

    // Prepare email payload for SendGrid
    const body = {
      personalizations: [
        {
          to: recipients.map((email) => ({ email })),
        },
      ],
      from: {
        email: this.settings.senderEmailAddress,
      },
      subject,
      content: [
        {
          type: "text/plain",
          value: emailContent,
        },
      ],
    };

    try {
      await fetch(SENDGRID_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.sendGridApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error("KeywordEmailNotifier email send failed:", e);
    }
  },

  // Settings UI: add a Test Email button
  settingsUI: {
    testEmail() {
      if (
        !this.settings.sendGridApiKey ||
        this.settings.multiEmailRecipients.length === 0
      ) {
        alert(
          "Please enter your SendGrid API key and at least one email recipient before testing."
        );
        return;
      }
      this.sendEmailNotification("test-email", {
        content: "This is a test email from KeywordEmailNotifier plugin.",
        guild_id: "test-server",
        channel_id: "test-channel",
        author: {
          username: "PluginTester",
          discriminator: "0001",
        },
        timestamp: Date.now(),
        id: "test-msg-id",
      });
      alert("Test email sent! Check your inbox.");
    },
  },
};