// ---------------------------------------------------------------------------
// GENERATED FILE - do not edit it by hand.
//
// A REDUCED, MODIFIED copy of parts of the npm package n8n-nodes-base 2.15.1,
// licensed under the Sustainable Use License v1.0. The upstream notices are not altered,
// removed or obscured: the attribution, the pinned hashes and the modification
// are in ./node-schema-NOTICE.md, and the licence itself is in
// ./node-schema-LICENSE.md.
//
//   upstream   n8n-nodes-base@2.15.1
//   tarball    https://registry.npmjs.org/n8n-nodes-base/-/n8n-nodes-base-2.15.1.tgz
//   sha-512    sha512-E4/vb8sBb4tzZSFoBAP2EigAHSc3uEn52RdfyTu1C7xPBNLYDfw5y5OxvMmHBQ8of9YQwcK9AQsoEsggyu7ztQ==
//   sha-256    43e200c1cbe1c4a9f967efa079facb00cc3cbe51ede23c9a3cfc66c9a4051406
//   provenance https://registry.npmjs.org/-/npm/v1/attestations/n8n-nodes-base@2.15.1
//
// Regenerate it with packages/n8n/scripts/generate-node-schema-snapshot.mjs.
// The content hash below is over the reduced data; the runtime refuses a file
// whose hash does not match.
// ---------------------------------------------------------------------------

import type { NodeSchemaSnapshot } from "@jarvis/core";

export const N8N_NODE_SCHEMA_SNAPSHOT: NodeSchemaSnapshot = {
  source: {
    "package": "n8n-nodes-base",
    "version": "2.15.1",
    "tarballUrl": "https://registry.npmjs.org/n8n-nodes-base/-/n8n-nodes-base-2.15.1.tgz",
    "sha512": "E4/vb8sBb4tzZSFoBAP2EigAHSc3uEn52RdfyTu1C7xPBNLYDfw5y5OxvMmHBQ8of9YQwcK9AQsoEsggyu7ztQ==",
    "sha256": "43e200c1cbe1c4a9f967efa079facb00cc3cbe51ede23c9a3cfc66c9a4051406",
    "provenanceUrl": "https://registry.npmjs.org/-/npm/v1/attestations/n8n-nodes-base@2.15.1",
    "license": "Sustainable Use License v1.0",
    "licenseFile": "node-schema-LICENSE.md",
    "contentHash": "df1477b744e148ae1bec30775206647028f269b35e6b0b67a268d8d8751aa8ef"
  },
  nodes: {
    "n8n-nodes-base.webhook": {
      "type": "n8n-nodes-base.webhook",
      "label": "Webhook",
      "versions": [
        "1",
        "1.1",
        "2",
        "2.1"
      ],
      "parameters": [
        {
          "name": "multipleMethods",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "Allow Multiple HTTP Methods"
        },
        {
          "name": "httpMethod",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "HTTP Method",
          "options": [
            "DELETE",
            "GET",
            "HEAD",
            "PATCH",
            "POST",
            "PUT"
          ]
        },
        {
          "name": "httpMethod",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "HTTP Methods",
          "options": [
            "DELETE",
            "GET",
            "HEAD",
            "PATCH",
            "POST",
            "PUT"
          ]
        },
        {
          "name": "path",
          "type": "string",
          "required": false,
          "conditional": false,
          "displayName": "Path"
        },
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "basicAuth",
            "headerAuth",
            "jwtAuth",
            "none"
          ]
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond",
          "options": [
            "onReceived",
            "lastNode",
            "responseNode"
          ]
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond",
          "options": [
            "onReceived",
            "lastNode",
            "responseNode",
            "streaming"
          ]
        },
        {
          "name": "responseCode",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Response Code",
          "min": 100,
          "max": 599
        },
        {
          "name": "responseData",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Data",
          "options": [
            "allEntries",
            "firstEntryJson",
            "firstEntryBinary",
            "noData"
          ]
        },
        {
          "name": "responseBinaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Property Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.1"
    },
    "n8n-nodes-base.formTrigger": {
      "type": "n8n-nodes-base.formTrigger",
      "label": "n8n Form Trigger",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3",
        "2.4",
        "2.5"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "basicAuth",
            "none"
          ]
        },
        {
          "name": "path",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Form Path"
        },
        {
          "name": "formTitle",
          "type": "string",
          "required": true,
          "conditional": false,
          "displayName": "Form Title"
        },
        {
          "name": "formDescription",
          "type": "string",
          "required": false,
          "conditional": false,
          "displayName": "Form Description"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond When",
          "options": [
            "onReceived",
            "lastNode",
            "responseNode"
          ]
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond When",
          "options": [
            "onReceived",
            "lastNode"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.5"
    },
    "n8n-nodes-base.scheduleTrigger": {
      "type": "n8n-nodes-base.scheduleTrigger",
      "label": "Schedule Trigger",
      "versions": [
        "1",
        "1.1",
        "1.2",
        "1.3"
      ],
      "parameters": [
        {
          "name": "rule",
          "type": "fixedCollection",
          "required": false,
          "conditional": false,
          "displayName": "Trigger Rules"
        }
      ],
      "defaultVersion": "1.3"
    },
    "n8n-nodes-base.manualTrigger": {
      "type": "n8n-nodes-base.manualTrigger",
      "label": "Manual Trigger",
      "versions": [
        "1"
      ],
      "parameters": [],
      "defaultVersion": "1"
    },
    "n8n-nodes-base.emailReadImap": {
      "type": "n8n-nodes-base.emailReadImap",
      "label": "Email Trigger (IMAP)",
      "versions": [
        "1",
        "2",
        "2.1"
      ],
      "parameters": [
        {
          "name": "mailbox",
          "type": "string",
          "required": false,
          "conditional": false,
          "displayName": "Mailbox Name"
        },
        {
          "name": "postProcessAction",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Action",
          "options": [
            "read",
            "nothing"
          ]
        },
        {
          "name": "downloadAttachments",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Download Attachments"
        },
        {
          "name": "format",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Format",
          "options": [
            "raw",
            "resolved",
            "simple"
          ]
        },
        {
          "name": "dataPropertyAttachmentsPrefixName",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Property Prefix Name"
        },
        {
          "name": "dataPropertyAttachmentsPrefixName",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Property Prefix Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.1"
    },
    "n8n-nodes-base.errorTrigger": {
      "type": "n8n-nodes-base.errorTrigger",
      "label": "Error Trigger",
      "versions": [
        "1"
      ],
      "parameters": [],
      "defaultVersion": "1"
    },
    "n8n-nodes-base.executeWorkflowTrigger": {
      "type": "n8n-nodes-base.executeWorkflowTrigger",
      "label": "Execute Workflow Trigger",
      "versions": [
        "1",
        "1.1"
      ],
      "parameters": [
        {
          "name": "events",
          "type": "hidden",
          "required": false,
          "conditional": false,
          "displayName": "Events"
        },
        {
          "name": "inputSource",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Input data mode",
          "options": [
            "workflowInputs",
            "jsonExample",
            "passthrough"
          ]
        },
        {
          "name": "jsonExample",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "JSON Example"
        },
        {
          "name": "workflowInputs",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Workflow Input Schema"
        }
      ],
      "defaultVersion": "1.1"
    },
    "n8n-nodes-base.slack": {
      "type": "n8n-nodes-base.slack",
      "label": "Slack",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3",
        "2.4"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "accessToken",
            "oAuth2"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "channel",
            "file",
            "message",
            "reaction",
            "star",
            "user",
            "userGroup"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "archive",
            "close",
            "create",
            "get",
            "getAll",
            "history",
            "invite",
            "join",
            "kick",
            "leave",
            "member",
            "open",
            "rename",
            "replies",
            "setPurpose",
            "setTopic",
            "unarchive"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "channelId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "channelVisibility",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Channel Visibility",
          "options": [
            "public",
            "private"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "userIds",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "User Names or IDs"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "userId",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "User Name or ID"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "resolveData",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Resolve Data"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "ts",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "purpose",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Purpose"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "topic",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Topic"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "delete",
            "getPermalink",
            "search",
            "post",
            "sendAndWait",
            "update"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "timestamp",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "select",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Send Message To",
          "options": [
            "channel",
            "user"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "user",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "messageType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Message Type",
          "options": [
            "text",
            "block",
            "attachment"
          ]
        },
        {
          "name": "text",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message Text"
        },
        {
          "name": "blocksUi",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Blocks"
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Notification Text"
        },
        {
          "name": "attachments",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Attachments"
        },
        {
          "name": "otherOptions",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "ts",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "messageType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Message Type",
          "options": [
            "text",
            "block",
            "attachment"
          ]
        },
        {
          "name": "blocksUi",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Blocks"
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Notification Text"
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message Text"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "otherOptions",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "select",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Delete Message From",
          "options": [
            "channel",
            "user"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "user",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "timestamp",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "query",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Search Query"
        },
        {
          "name": "sort",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Sort By",
          "options": [
            "desc",
            "asc",
            "relevance"
          ]
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 50
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "select",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Send Message To",
          "options": [
            "channel",
            "user"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "user",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "add",
            "delete",
            "getAll"
          ]
        },
        {
          "name": "target",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Item to Add Star",
          "options": [
            "message",
            "file"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "fileId",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File ID"
        },
        {
          "name": "timestamp",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get",
            "getAll",
            "upload"
          ]
        },
        {
          "name": "binaryData",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Binary File"
        },
        {
          "name": "fileContent",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File Content"
        },
        {
          "name": "binaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "File Property"
        },
        {
          "name": "binaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "File Property"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "fileId",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File ID"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "add",
            "get",
            "remove"
          ]
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "timestamp",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Message Timestamp"
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Emoji Code"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "info",
            "getAll",
            "getProfile",
            "getPresence",
            "updateProfile"
          ]
        },
        {
          "name": "user",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "user",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "updateUsers",
            "create",
            "disable",
            "enable",
            "getAll",
            "getUsers",
            "update"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "Options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "userGroupId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User Group ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "userGroupId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User Group ID"
        },
        {
          "name": "option",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "userGroupId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User Group ID"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "userGroupId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User Group ID"
        },
        {
          "name": "users",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "User Names or IDs"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "userGroupId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User Group ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.4"
    },
    "n8n-nodes-base.discord": {
      "type": "n8n-nodes-base.discord",
      "label": "Discord",
      "versions": [
        "1",
        "2"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Connection Type",
          "options": [
            "botToken",
            "oAuth2",
            "webhook"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Resource",
          "options": [
            "channel",
            "message",
            "member"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "deleteMessage",
            "get",
            "getAll",
            "react",
            "send",
            "sendAndWait"
          ]
        },
        {
          "name": "guildId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Server"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "emoji",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Emoji"
        },
        {
          "name": "sendTo",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Send To",
          "options": [
            "user",
            "channel"
          ]
        },
        {
          "name": "userId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "content",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "embeds",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Embeds"
        },
        {
          "name": "files",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Files"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "sendTo",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Send To",
          "options": [
            "user",
            "channel"
          ]
        },
        {
          "name": "userId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteChannel",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "guildId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Server"
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "type",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Type",
          "options": [
            "0",
            "2",
            "4"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "getAll",
            "roleAdd",
            "roleRemove"
          ]
        },
        {
          "name": "guildId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Server"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "after",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "After"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "userId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "role",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "Role"
        },
        {
          "name": "userId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "User"
        },
        {
          "name": "role",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "Role"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "sendLegacy"
          ]
        },
        {
          "name": "content",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "embeds",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Embeds"
        },
        {
          "name": "files",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Files"
        }
      ],
      "defaultVersion": "2"
    },
    "n8n-nodes-base.telegram": {
      "type": "n8n-nodes-base.telegram",
      "label": "Telegram",
      "versions": [
        "1",
        "1.1",
        "1.2"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "chat",
            "callback",
            "file",
            "message"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get",
            "administrators",
            "member",
            "leave",
            "setDescription",
            "setTitle"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "answerQuery",
            "answerInlineQuery"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "deleteMessage",
            "editMessageText",
            "pinChatMessage",
            "sendAnimation",
            "sendAudio",
            "sendChatAction",
            "sendDocument",
            "sendLocation",
            "sendMediaGroup",
            "sendMessage",
            "sendAndWait",
            "sendPhoto",
            "sendSticker",
            "sendVideo",
            "unpinChatMessage"
          ]
        },
        {
          "name": "chatId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Chat ID"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "userId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User ID"
        },
        {
          "name": "description",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Description"
        },
        {
          "name": "title",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "queryId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Query ID"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "queryId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Query ID"
        },
        {
          "name": "results",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Results"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "fileId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "File ID"
        },
        {
          "name": "download",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Download"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "messageType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Message Type",
          "options": [
            "inlineMessage",
            "message"
          ]
        },
        {
          "name": "chatId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Chat ID"
        },
        {
          "name": "binaryData",
          "type": "boolean",
          "required": true,
          "conditional": true,
          "displayName": "Binary File"
        },
        {
          "name": "binaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Input Binary Field"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "inlineMessageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Inline Message ID"
        },
        {
          "name": "replyMarkup",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Reply Markup",
          "options": [
            "none",
            "inlineKeyboard"
          ]
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Animation"
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Audio"
        },
        {
          "name": "action",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Action",
          "options": [
            "find_location",
            "record_audio",
            "record_video",
            "record_video_note",
            "typing",
            "upload_audio",
            "upload_document",
            "upload_photo",
            "upload_video",
            "upload_video_note"
          ]
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Document"
        },
        {
          "name": "latitude",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Latitude",
          "min": -90,
          "max": 90
        },
        {
          "name": "longitude",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Longitude",
          "min": -180,
          "max": 180
        },
        {
          "name": "media",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Media"
        },
        {
          "name": "text",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Text"
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Photo"
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Sticker"
        },
        {
          "name": "file",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Video"
        },
        {
          "name": "replyMarkup",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Reply Markup",
          "options": [
            "forceReply",
            "inlineKeyboard",
            "none",
            "replyKeyboard",
            "replyKeyboardRemove"
          ]
        },
        {
          "name": "forceReply",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Force Reply"
        },
        {
          "name": "inlineKeyboard",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Inline Keyboard"
        },
        {
          "name": "replyKeyboard",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Reply Keyboard"
        },
        {
          "name": "replyKeyboardOptions",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Reply Keyboard Options"
        },
        {
          "name": "replyKeyboardRemove",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Reply Keyboard Remove"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "chatId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Chat ID"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "1.2"
    },
    "n8n-nodes-base.microsoftTeams": {
      "type": "n8n-nodes-base.microsoftTeams",
      "label": "Microsoft Teams",
      "versions": [
        "1",
        "2",
        "1.1"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "channel",
            "channelMessage",
            "chatMessage",
            "task"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteChannel",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "New Channel Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "getAll"
          ]
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "contentType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Content Type",
          "options": [
            "text",
            "html"
          ]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "teamId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "channelId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Channel"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "get",
            "getAll",
            "sendAndWait"
          ]
        },
        {
          "name": "chatId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Chat"
        },
        {
          "name": "contentType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Content Type",
          "options": [
            "text",
            "html"
          ]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "chatId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Chat"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "chatId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Chat"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "chatId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Chat"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteTask",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "groupId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "planId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Plan"
        },
        {
          "name": "bucketId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Bucket"
        },
        {
          "name": "title",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "taskId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Task ID"
        },
        {
          "name": "taskId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Task ID"
        },
        {
          "name": "tasksFor",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Tasks For",
          "options": [
            "member",
            "plan"
          ]
        },
        {
          "name": "groupId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Team"
        },
        {
          "name": "planId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Plan"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "taskId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Task ID"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        }
      ],
      "defaultVersion": "2"
    },
    "n8n-nodes-base.gmail": {
      "type": "n8n-nodes-base.gmail",
      "label": "Gmail",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "oAuth2",
            "serviceAccount"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "message",
            "label",
            "draft",
            "thread"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll"
          ]
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Draft ID"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "emailType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Email Type",
          "options": [
            "html",
            "text"
          ]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "labelId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Label ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "addLabels",
            "delete",
            "get",
            "getAll",
            "markAsRead",
            "markAsUnread",
            "removeLabels",
            "reply",
            "send",
            "sendAndWait"
          ]
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "sendTo",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "emailType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Email Type",
          "options": [
            "text",
            "html"
          ]
        },
        {
          "name": "emailType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Email Type",
          "options": [
            "text",
            "html"
          ]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "messageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message ID"
        },
        {
          "name": "labelIds",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "Label Names or IDs"
        },
        {
          "name": "sendTo",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "addLabels",
            "delete",
            "get",
            "getAll",
            "removeLabels",
            "reply",
            "trash",
            "untrash"
          ]
        },
        {
          "name": "threadId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Thread ID"
        },
        {
          "name": "messageId",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Message Snippet or ID"
        },
        {
          "name": "emailType",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Email Type",
          "options": [
            "text",
            "html"
          ]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "threadId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Thread ID"
        },
        {
          "name": "labelIds",
          "type": "multiOptions",
          "required": true,
          "conditional": true,
          "displayName": "Label Names or IDs"
        }
      ],
      "defaultVersion": "2.2"
    },
    "n8n-nodes-base.emailSend": {
      "type": "n8n-nodes-base.emailSend",
      "label": "Send Email",
      "versions": [
        "1",
        "2",
        "2.1"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "hidden",
          "required": false,
          "conditional": false,
          "displayName": "Resource"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "send",
            "sendAndWait"
          ]
        },
        {
          "name": "fromEmail",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "From Email"
        },
        {
          "name": "toEmail",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To Email"
        },
        {
          "name": "subject",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "emailFormat",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Email Format",
          "options": [
            "text",
            "html",
            "both"
          ]
        },
        {
          "name": "emailFormat",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Email Format",
          "options": [
            "text",
            "html",
            "both"
          ]
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Text"
        },
        {
          "name": "html",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "HTML"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "fromEmail",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "From Email"
        },
        {
          "name": "toEmail",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To Email"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.1"
    },
    "n8n-nodes-base.microsoftOutlook": {
      "type": "n8n-nodes-base.microsoftOutlook",
      "label": "Microsoft Outlook",
      "versions": [
        "1",
        "2"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "calendar",
            "contact",
            "draft",
            "event",
            "folder",
            "folderMessage",
            "message",
            "messageAttachment"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "givenName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "First Name"
        },
        {
          "name": "surname",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Last Name"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "contactId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Contact"
        },
        {
          "name": "contactId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Contact"
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "createdDateTime",
            "lastModifiedDateTime",
            "changeKey",
            "categories",
            "parentFolderId",
            "birthday",
            "fileAs",
            "displayName",
            "givenName",
            "initials",
            "middleName",
            "nickName",
            "surname",
            "title",
            "yomiGivenName",
            "yomiSurname",
            "yomiCompanyName",
            "generation",
            "imAddresses",
            "jobTitle",
            "companyName",
            "department",
            "officeLocation",
            "profession",
            "businessHomePage",
            "assistantName",
            "manager",
            "homePhones",
            "mobilePhone",
            "businessPhones",
            "spouseName",
            "personalNotes",
            "children",
            "emailAddresses",
            "homeAddress",
            "businessAddress",
            "otherAddress"
          ]
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "createdDateTime",
            "lastModifiedDateTime",
            "changeKey",
            "categories",
            "parentFolderId",
            "birthday",
            "fileAs",
            "displayName",
            "givenName",
            "initials",
            "middleName",
            "nickName",
            "surname",
            "title",
            "yomiGivenName",
            "yomiSurname",
            "yomiCompanyName",
            "generation",
            "imAddresses",
            "jobTitle",
            "companyName",
            "department",
            "officeLocation",
            "profession",
            "businessHomePage",
            "assistantName",
            "manager",
            "homePhones",
            "mobilePhone",
            "businessPhones",
            "spouseName",
            "personalNotes",
            "children",
            "emailAddresses",
            "homeAddress",
            "businessAddress",
            "otherAddress"
          ]
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "contactId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Contact"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "send",
            "update"
          ]
        },
        {
          "name": "subject",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "bodyContent",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "draftId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Draft"
        },
        {
          "name": "draftId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Draft"
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "bccRecipients",
            "body",
            "bodyPreview",
            "categories",
            "ccRecipients",
            "changeKey",
            "conversationId",
            "createdDateTime",
            "flag",
            "from",
            "hasAttachments",
            "importance",
            "inferenceClassification",
            "internetMessageId",
            "isDeliveryReceiptRequested",
            "isDraft",
            "isRead",
            "isReadReceiptRequested",
            "lastModifiedDateTime",
            "parentFolderId",
            "receivedDateTime",
            "replyTo",
            "sender",
            "sentDateTime",
            "subject",
            "toRecipients",
            "webLink"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "draftId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Draft"
        },
        {
          "name": "to",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "To"
        },
        {
          "name": "draftId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Draft"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "startDateTime",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Start"
        },
        {
          "name": "endDateTime",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "End"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "eventId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Event"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "eventId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Event"
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "allowNewTimeProposals",
            "attendees",
            "body",
            "bodyPreview",
            "categories",
            "changeKey",
            "createdDateTime",
            "end",
            "hasAttachments",
            "hideAttendees",
            "iCalUId",
            "importance",
            "isAllDay",
            "isCancelled",
            "isDraft",
            "isOnlineMeeting",
            "isOrganizer",
            "isReminderOn",
            "lastModifiedDateTime",
            "location",
            "locations",
            "onlineMeeting",
            "onlineMeetingProvider",
            "onlineMeetingUrl",
            "organizer",
            "originalEndTimeZone",
            "originalStartTimeZone",
            "recurrence",
            "reminderMinutesBeforeStart",
            "responseRequested",
            "responseStatus",
            "sensitivity",
            "seriesMasterId",
            "showAs",
            "start",
            "subject",
            "transactionId",
            "type",
            "webLink"
          ]
        },
        {
          "name": "fromAllCalendars",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "From All Calendars"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "allowNewTimeProposals",
            "attendees",
            "body",
            "bodyPreview",
            "categories",
            "changeKey",
            "createdDateTime",
            "end",
            "hasAttachments",
            "hideAttendees",
            "iCalUId",
            "importance",
            "isAllDay",
            "isCancelled",
            "isDraft",
            "isOnlineMeeting",
            "isOrganizer",
            "isReminderOn",
            "lastModifiedDateTime",
            "location",
            "locations",
            "onlineMeeting",
            "onlineMeetingProvider",
            "onlineMeetingUrl",
            "organizer",
            "originalEndTimeZone",
            "originalStartTimeZone",
            "recurrence",
            "reminderMinutesBeforeStart",
            "responseRequested",
            "responseStatus",
            "sensitivity",
            "seriesMasterId",
            "showAs",
            "start",
            "subject",
            "transactionId",
            "type",
            "webLink"
          ]
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "calendarId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "eventId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Event"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "displayName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "displayName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "getAll"
          ]
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "bccRecipients",
            "body",
            "bodyPreview",
            "categories",
            "ccRecipients",
            "changeKey",
            "conversationId",
            "createdDateTime",
            "flag",
            "from",
            "hasAttachments",
            "importance",
            "inferenceClassification",
            "internetMessageId",
            "isDeliveryReceiptRequested",
            "isDraft",
            "isRead",
            "isReadReceiptRequested",
            "lastModifiedDateTime",
            "parentFolderId",
            "receivedDateTime",
            "replyTo",
            "sender",
            "sentDateTime",
            "subject",
            "toRecipients",
            "webLink"
          ]
        },
        {
          "name": "filtersUI",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "delete",
            "get",
            "getAll",
            "move",
            "reply",
            "send",
            "sendAndWait",
            "update"
          ]
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "bccRecipients",
            "body",
            "bodyPreview",
            "categories",
            "ccRecipients",
            "changeKey",
            "conversationId",
            "createdDateTime",
            "flag",
            "from",
            "hasAttachments",
            "importance",
            "inferenceClassification",
            "internetMessageId",
            "isDeliveryReceiptRequested",
            "isDraft",
            "isRead",
            "isReadReceiptRequested",
            "lastModifiedDateTime",
            "parentFolderId",
            "receivedDateTime",
            "replyTo",
            "sender",
            "sentDateTime",
            "subject",
            "toRecipients",
            "webLink"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "output",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Output",
          "options": [
            "simple",
            "raw",
            "fields"
          ]
        },
        {
          "name": "fields",
          "type": "multiOptions",
          "required": false,
          "conditional": true,
          "displayName": "Fields",
          "options": [
            "bccRecipients",
            "body",
            "bodyPreview",
            "categories",
            "ccRecipients",
            "changeKey",
            "conversationId",
            "createdDateTime",
            "flag",
            "from",
            "hasAttachments",
            "importance",
            "inferenceClassification",
            "internetMessageId",
            "isDeliveryReceiptRequested",
            "isDraft",
            "isRead",
            "isReadReceiptRequested",
            "lastModifiedDateTime",
            "parentFolderId",
            "receivedDateTime",
            "replyTo",
            "sender",
            "sentDateTime",
            "subject",
            "toRecipients",
            "webLink"
          ]
        },
        {
          "name": "filtersUI",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "replyToSenderOnly",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Reply to Sender Only"
        },
        {
          "name": "message",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "toRecipients",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To"
        },
        {
          "name": "subject",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "bodyContent",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "toRecipients",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "To"
        },
        {
          "name": "subject",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Subject"
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Type",
          "options": [
            "approval",
            "freeText",
            "customForm"
          ]
        },
        {
          "name": "defineForm",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Define Form",
          "options": [
            "fields",
            "json"
          ]
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "Form Fields"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "approvalOptions",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Approval Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "add",
            "download",
            "get",
            "getAll"
          ]
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "binaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Input Data Field Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "attachmentId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Attachment"
        },
        {
          "name": "binaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Put Output in Field"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "attachmentId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Attachment"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "messageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Message"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2"
    },
    "n8n-nodes-base.googleSheets": {
      "type": "n8n-nodes-base.googleSheets",
      "label": "Google Sheets",
      "versions": [
        "1",
        "2",
        "3",
        "4",
        "4.1",
        "4.2",
        "4.3",
        "4.4",
        "4.5",
        "4.6",
        "4.7"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "serviceAccount",
            "oAuth2"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "spreadsheet",
            "sheet"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "appendOrUpdate",
            "append",
            "clear",
            "create",
            "remove",
            "delete",
            "read",
            "update"
          ]
        },
        {
          "name": "documentId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Document"
        },
        {
          "name": "sheetName",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Sheet"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow",
            "nothing"
          ]
        },
        {
          "name": "fieldsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "clear",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Clear",
          "options": [
            "wholeSheet",
            "specificRows",
            "specificColumns",
            "specificRange"
          ]
        },
        {
          "name": "keepFirstRow",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Keep First Row"
        },
        {
          "name": "startIndex",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Start Row Number",
          "min": 1
        },
        {
          "name": "rowsToDelete",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Number of Rows to Delete",
          "min": 1
        },
        {
          "name": "startIndex",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Start Column"
        },
        {
          "name": "columnsToDelete",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Number of Columns to Delete",
          "min": 1
        },
        {
          "name": "range",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Range"
        },
        {
          "name": "title",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "toDelete",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "To Delete",
          "options": [
            "rows",
            "columns"
          ]
        },
        {
          "name": "startIndex",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Start Row Number",
          "min": 1
        },
        {
          "name": "numberToDelete",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Number of Rows to Delete",
          "min": 1
        },
        {
          "name": "startIndex",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Start Column"
        },
        {
          "name": "numberToDelete",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Number of Columns to Delete",
          "min": 1
        },
        {
          "name": "filtersUI",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "combineFilters",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Filters",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "combineFilters",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Filters",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow",
            "nothing"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Column to match on"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Column to Match On"
        },
        {
          "name": "fieldsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow",
            "nothing"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Column to match on"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Column to Match On"
        },
        {
          "name": "fieldsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteSpreadsheet"
          ]
        },
        {
          "name": "title",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "sheetsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Sheets"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "documentId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Document"
        }
      ],
      "defaultVersion": "4.7"
    },
    "n8n-nodes-base.airtable": {
      "type": "n8n-nodes-base.airtable",
      "label": "Airtable",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "airtableTokenApi",
            "airtableOAuth2Api"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "base",
            "record"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "upsert",
            "deleteRecord",
            "get",
            "search",
            "update"
          ]
        },
        {
          "name": "base",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Base"
        },
        {
          "name": "table",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Table"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "id",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Record ID"
        },
        {
          "name": "id",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Record ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "filterByFormula",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Filter By Formula"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "sort",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Sort"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "getMany",
            "getSchema"
          ]
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "base",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Base"
        }
      ],
      "defaultVersion": "2.2"
    },
    "n8n-nodes-base.postgres": {
      "type": "n8n-nodes-base.postgres",
      "label": "Postgres",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3",
        "2.4",
        "2.5",
        "2.6"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "hidden",
          "required": false,
          "conditional": false,
          "displayName": "Resource"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "deleteTable",
            "executeQuery",
            "insert",
            "upsert",
            "select",
            "update"
          ]
        },
        {
          "name": "schema",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Schema"
        },
        {
          "name": "table",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Table"
        },
        {
          "name": "deleteCommand",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Command",
          "options": [
            "truncate",
            "delete",
            "drop"
          ]
        },
        {
          "name": "restartSequences",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Restart Sequences"
        },
        {
          "name": "where",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Select Rows"
        },
        {
          "name": "combineConditions",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Conditions",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "query",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Query"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "where",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Select Rows"
        },
        {
          "name": "combineConditions",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Conditions",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "sort",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Sort"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Column to Match On"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Column to Match On"
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Unique Column"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Unique Column"
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "columns",
          "type": "resourceMapper",
          "required": true,
          "conditional": true,
          "displayName": "Columns"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.6"
    },
    "n8n-nodes-base.mySql": {
      "type": "n8n-nodes-base.mySql",
      "label": "MySQL",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3",
        "2.4",
        "2.5"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "hidden",
          "required": false,
          "conditional": false,
          "displayName": "Resource"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "deleteTable",
            "executeQuery",
            "insert",
            "upsert",
            "select",
            "update"
          ]
        },
        {
          "name": "table",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Table"
        },
        {
          "name": "deleteCommand",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Command",
          "options": [
            "truncate",
            "delete",
            "drop"
          ]
        },
        {
          "name": "where",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Select Rows"
        },
        {
          "name": "combineConditions",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Conditions",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "query",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Query"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "where",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Select Rows"
        },
        {
          "name": "combineConditions",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Combine Conditions",
          "options": [
            "AND",
            "OR"
          ]
        },
        {
          "name": "sort",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Sort"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Column to Match On"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Column to Match On"
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dataMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Data Mode",
          "options": [
            "autoMapInputData",
            "defineBelow"
          ]
        },
        {
          "name": "columnToMatchOn",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Column to Match On"
        },
        {
          "name": "valueToMatchOn",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Value of Column to Match On"
        },
        {
          "name": "valuesToSend",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Values to Send"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.5"
    },
    "n8n-nodes-base.hubspot": {
      "type": "n8n-nodes-base.hubspot",
      "label": "HubSpot",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "apiKey",
            "appToken",
            "oAuth2"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "company",
            "contact",
            "contactList",
            "deal",
            "engagement",
            "ticket"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "upsert",
            "delete",
            "get",
            "getAll",
            "getRecentlyCreatedUpdated",
            "search"
          ]
        },
        {
          "name": "email",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Email"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Contact Properties"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "contactId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Contact to Get"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "contactId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Contact to Delete"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "filterGroupsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filter Groups"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "add",
            "remove"
          ]
        },
        {
          "name": "by",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "By",
          "options": [
            "id",
            "email"
          ]
        },
        {
          "name": "email",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Email"
        },
        {
          "name": "id",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Contact to Add"
        },
        {
          "name": "listId",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "List to Add To"
        },
        {
          "name": "id",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "Contact to Remove"
        },
        {
          "name": "listId",
          "type": "number",
          "required": true,
          "conditional": true,
          "displayName": "List to Remove From"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "getRecentlyCreatedUpdated",
            "searchByDomain",
            "update"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Company Properties"
        },
        {
          "name": "companyId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Company to Update"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "companyId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Company to Get"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "companyId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Company to Delete"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "domain",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Domain"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "getRecentlyCreatedUpdated",
            "search",
            "update"
          ]
        },
        {
          "name": "stage",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Deal Stage Name or ID"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Deal Properties"
        },
        {
          "name": "dealId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Deal to Update"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "dealId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Deal to Get"
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "dealId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Deal to Delete"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "filters",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "filterGroupsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filter Groups"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll"
          ]
        },
        {
          "name": "type",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Type",
          "options": [
            "call",
            "email",
            "meeting",
            "task"
          ]
        },
        {
          "name": "dueDate",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Due Date"
        },
        {
          "name": "metadata",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Metadata"
        },
        {
          "name": "metadata",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Metadata"
        },
        {
          "name": "metadata",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Metadata"
        },
        {
          "name": "metadata",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Metadata"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Engagement Properties"
        },
        {
          "name": "engagementId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Engagement to Get"
        },
        {
          "name": "engagementId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Engagement to Delete"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "pipelineId",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Pipeline Name or ID"
        },
        {
          "name": "stageId",
          "type": "options",
          "required": true,
          "conditional": true,
          "displayName": "Stage Name or ID"
        },
        {
          "name": "ticketName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Ticket Name"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Ticket Properties"
        },
        {
          "name": "ticketId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Ticket to Update"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "ticketId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Ticket to Get"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 250
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "ticketId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Ticket to Delete"
        }
      ],
      "defaultVersion": "2.2"
    },
    "n8n-nodes-base.notion": {
      "type": "n8n-nodes-base.notion",
      "label": "Notion",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2"
      ],
      "parameters": [
        {
          "name": "Credentials",
          "type": "credentials",
          "required": false,
          "conditional": false
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "block",
            "database",
            "databasePage",
            "page",
            "user"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "append",
            "getAll"
          ]
        },
        {
          "name": "blockId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Block"
        },
        {
          "name": "blockId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Block"
        },
        {
          "name": "blockUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Blocks"
        },
        {
          "name": "blockId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Block"
        },
        {
          "name": "blockId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Block"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "fetchNestedBlocks",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Also Fetch Nested Blocks"
        },
        {
          "name": "simplifyOutput",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify Output"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get",
            "getAll",
            "search"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get",
            "getAll"
          ]
        },
        {
          "name": "databaseId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Database"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Search Text"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "getAll",
            "update"
          ]
        },
        {
          "name": "databaseId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Database"
        },
        {
          "name": "title",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "propertiesUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Properties"
        },
        {
          "name": "blockUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Blocks"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "pageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Database Page"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "propertiesUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Properties"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "pageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Database Page"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "databaseId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Database"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "filterType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Filter",
          "options": [
            "none",
            "manual",
            "json"
          ]
        },
        {
          "name": "matchType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Must Match",
          "options": [
            "anyFilter",
            "allFilters"
          ]
        },
        {
          "name": "filters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Filters"
        },
        {
          "name": "filterJson",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Filters (JSON)"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "get",
            "search"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "archive",
            "create",
            "search"
          ]
        },
        {
          "name": "pageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Page"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "pageId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Page"
        },
        {
          "name": "title",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Title"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "blockUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Blocks"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "pageId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Page Link or ID"
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "text",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Search Text"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        },
        {
          "name": "simple",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Simplify"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "get",
            "getAll"
          ]
        },
        {
          "name": "userId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "User ID"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 100
        }
      ],
      "defaultVersion": "2.2"
    },
    "n8n-nodes-base.googleCalendar": {
      "type": "n8n-nodes-base.googleCalendar",
      "label": "Google Calendar",
      "versions": [
        "1",
        "1.1",
        "1.2",
        "1.3"
      ],
      "parameters": [
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "calendar",
            "event"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "availability"
          ]
        },
        {
          "name": "calendar",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "timeMin",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Start Time"
        },
        {
          "name": "timeMax",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "End Time"
        },
        {
          "name": "timeMin",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Start Time"
        },
        {
          "name": "timeMax",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "End Time"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "delete",
            "get",
            "getAll",
            "update"
          ]
        },
        {
          "name": "calendar",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Calendar"
        },
        {
          "name": "start",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Start"
        },
        {
          "name": "end",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "End"
        },
        {
          "name": "start",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Start"
        },
        {
          "name": "end",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "End"
        },
        {
          "name": "useDefaultReminders",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Use Default Reminders"
        },
        {
          "name": "additionalFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Additional Fields"
        },
        {
          "name": "remindersUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Reminders"
        },
        {
          "name": "eventId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Event ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "eventId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Event ID"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 500
        },
        {
          "name": "timeMin",
          "type": "dateTime",
          "required": false,
          "conditional": true,
          "displayName": "After"
        },
        {
          "name": "timeMax",
          "type": "dateTime",
          "required": false,
          "conditional": true,
          "displayName": "Before"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "eventId",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Event ID"
        },
        {
          "name": "modifyTarget",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Modify",
          "options": [
            "instance",
            "event"
          ]
        },
        {
          "name": "useDefaultReminders",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Use Default Reminders"
        },
        {
          "name": "updateFields",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "remindersUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Reminders"
        }
      ],
      "defaultVersion": "1.3"
    },
    "n8n-nodes-base.googleDrive": {
      "type": "n8n-nodes-base.googleDrive",
      "label": "Google Drive",
      "versions": [
        "1",
        "2",
        "3"
      ],
      "parameters": [
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "oAuth2",
            "serviceAccount"
          ]
        },
        {
          "name": "resource",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resource",
          "options": [
            "file",
            "fileFolder",
            "folder",
            "drive"
          ]
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteDrive",
            "get",
            "list",
            "update"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Shared Drive"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Shared Drive"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1,
          "max": 200
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Shared Drive"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Update Fields"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "copy",
            "createFromText",
            "deleteFile",
            "download",
            "move",
            "share",
            "update",
            "upload"
          ]
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File"
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File Name"
        },
        {
          "name": "sameFolder",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Copy In The Same Folder"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Drive"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "content",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File Content"
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File Name"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "Parent Drive"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": false,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Drive"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File"
        },
        {
          "name": "permissionsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Permissions"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "fileId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "File to Update"
        },
        {
          "name": "changeFileContent",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Change File Content"
        },
        {
          "name": "inputDataFieldName",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Input Data Field Name"
        },
        {
          "name": "newUpdatedFileName",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "New Updated File Name"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "inputDataFieldName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Input Data Field Name"
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "File Name"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Drive"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "search"
          ]
        },
        {
          "name": "searchMethod",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Search Method",
          "options": [
            "name",
            "query"
          ]
        },
        {
          "name": "queryString",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Search Query"
        },
        {
          "name": "queryString",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Query String"
        },
        {
          "name": "returnAll",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return All"
        },
        {
          "name": "limit",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Limit",
          "min": 1
        },
        {
          "name": "filter",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Filter"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "operation",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Operation",
          "options": [
            "create",
            "deleteFolder",
            "share"
          ]
        },
        {
          "name": "name",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Folder Name"
        },
        {
          "name": "driveId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Drive"
        },
        {
          "name": "folderId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Parent Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "folderNoRootId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "folderNoRootId",
          "type": "resourceLocator",
          "required": true,
          "conditional": true,
          "displayName": "Folder"
        },
        {
          "name": "permissionsUi",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Permissions"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "3"
    },
    "n8n-nodes-base.httpRequest": {
      "type": "n8n-nodes-base.httpRequest",
      "label": "HTTP Request",
      "versions": [
        "1",
        "2",
        "3",
        "4",
        "4.1",
        "4.2",
        "4.3",
        "4.4"
      ],
      "parameters": [
        {
          "name": "curlImport",
          "type": "curlImport",
          "required": false,
          "conditional": false
        },
        {
          "name": "method",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Method",
          "options": [
            "DELETE",
            "GET",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "POST",
            "PUT"
          ]
        },
        {
          "name": "url",
          "type": "string",
          "required": true,
          "conditional": false,
          "displayName": "URL"
        },
        {
          "name": "authentication",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Authentication",
          "options": [
            "none",
            "predefinedCredentialType",
            "genericCredentialType"
          ]
        },
        {
          "name": "nodeCredentialType",
          "type": "credentialsSelect",
          "required": true,
          "conditional": true,
          "displayName": "Credential Type"
        },
        {
          "name": "genericAuthType",
          "type": "credentialsSelect",
          "required": true,
          "conditional": true,
          "displayName": "Generic Auth Type"
        },
        {
          "name": "provideSslCertificates",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "SSL Certificates"
        },
        {
          "name": "sslCertificate",
          "type": "credentials",
          "required": false,
          "conditional": true,
          "displayName": "SSL Certificate"
        },
        {
          "name": "sendQuery",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "Send Query Parameters"
        },
        {
          "name": "specifyQuery",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Specify Query Parameters",
          "options": [
            "keypair",
            "json"
          ]
        },
        {
          "name": "queryParameters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Query Parameters"
        },
        {
          "name": "jsonQuery",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "JSON"
        },
        {
          "name": "sendHeaders",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "Send Headers"
        },
        {
          "name": "specifyHeaders",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Specify Headers",
          "options": [
            "keypair",
            "json"
          ]
        },
        {
          "name": "headerParameters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Headers"
        },
        {
          "name": "jsonHeaders",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "JSON"
        },
        {
          "name": "sendBody",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "Send Body"
        },
        {
          "name": "contentType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Body Content Type",
          "options": [
            "form-urlencoded",
            "multipart-form-data",
            "json",
            "binaryData",
            "raw"
          ]
        },
        {
          "name": "specifyBody",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Specify Body",
          "options": [
            "keypair",
            "json"
          ]
        },
        {
          "name": "bodyParameters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Body Parameters"
        },
        {
          "name": "jsonBody",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "JSON"
        },
        {
          "name": "bodyParameters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Body"
        },
        {
          "name": "specifyBody",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Specify Body",
          "options": [
            "keypair",
            "string"
          ]
        },
        {
          "name": "bodyParameters",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Body Fields"
        },
        {
          "name": "body",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Body"
        },
        {
          "name": "inputDataFieldName",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Input Data Field Name"
        },
        {
          "name": "rawContentType",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Content Type"
        },
        {
          "name": "body",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Body"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        },
        {
          "name": "optimizeResponse",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Optimize Response"
        },
        {
          "name": "responseType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Expected Response Type",
          "options": [
            "json",
            "html",
            "text"
          ]
        },
        {
          "name": "dataField",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Field Containing Data"
        },
        {
          "name": "fieldsToInclude",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Include Fields",
          "options": [
            "all",
            "selected",
            "except"
          ]
        },
        {
          "name": "fields",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Fields"
        },
        {
          "name": "cssSelector",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Selector (CSS)"
        },
        {
          "name": "onlyContent",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Return Only Content"
        },
        {
          "name": "elementsToOmit",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Elements To Omit"
        },
        {
          "name": "truncateResponse",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Truncate Response"
        },
        {
          "name": "maxLength",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Max Response Characters",
          "min": 1
        }
      ],
      "defaultVersion": "4.4"
    },
    "n8n-nodes-base.set": {
      "type": "n8n-nodes-base.set",
      "label": "Set",
      "versions": [
        "1",
        "2",
        "3",
        "3.1",
        "3.2",
        "3.3",
        "3.4"
      ],
      "parameters": [
        {
          "name": "mode",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Mode",
          "options": [
            "manual",
            "raw"
          ]
        },
        {
          "name": "duplicateItem",
          "type": "boolean",
          "required": false,
          "conditional": false,
          "displayName": "Duplicate Item"
        },
        {
          "name": "duplicateCount",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Duplicate Item Count",
          "min": 0
        },
        {
          "name": "jsonOutput",
          "type": "json",
          "required": false,
          "conditional": true,
          "displayName": "JSON"
        },
        {
          "name": "fields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Set"
        },
        {
          "name": "assignments",
          "type": "assignmentCollection",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Set"
        },
        {
          "name": "include",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Include in Output",
          "options": [
            "all",
            "none",
            "selected",
            "except"
          ]
        },
        {
          "name": "includeOtherFields",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Include Other Input Fields"
        },
        {
          "name": "include",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Input Fields to Include",
          "options": [
            "all",
            "selected",
            "except"
          ]
        },
        {
          "name": "includeFields",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Include"
        },
        {
          "name": "excludeFields",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Exclude"
        },
        {
          "name": "includeFields",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Include"
        },
        {
          "name": "excludeFields",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Fields to Exclude"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "3.4"
    },
    "n8n-nodes-base.filter": {
      "type": "n8n-nodes-base.filter",
      "label": "Filter",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3"
      ],
      "parameters": [
        {
          "name": "conditions",
          "type": "filter",
          "required": false,
          "conditional": false,
          "displayName": "Conditions"
        },
        {
          "name": "looseTypeValidation",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Convert types where required"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.3"
    },
    "n8n-nodes-base.wait": {
      "type": "n8n-nodes-base.wait",
      "label": "Wait",
      "versions": [
        "1",
        "1.1"
      ],
      "parameters": [
        {
          "name": "resume",
          "type": "options",
          "required": false,
          "conditional": false,
          "displayName": "Resume",
          "options": [
            "timeInterval",
            "specificTime",
            "webhook",
            "form"
          ]
        },
        {
          "name": "incomingAuthentication",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Authentication",
          "options": [
            "basicAuth",
            "none"
          ]
        },
        {
          "name": "incomingAuthentication",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Authentication",
          "options": [
            "basicAuth",
            "headerAuth",
            "jwtAuth",
            "none"
          ]
        },
        {
          "name": "dateTime",
          "type": "dateTime",
          "required": true,
          "conditional": true,
          "displayName": "Date and Time"
        },
        {
          "name": "amount",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Wait Amount",
          "min": 0
        },
        {
          "name": "amount",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Wait Amount",
          "min": 0
        },
        {
          "name": "unit",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Wait Unit",
          "options": [
            "seconds",
            "minutes",
            "hours",
            "days"
          ]
        },
        {
          "name": "unit",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Wait Unit",
          "options": [
            "seconds",
            "minutes",
            "hours",
            "days"
          ]
        },
        {
          "name": "formTitle",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Form Title"
        },
        {
          "name": "formDescription",
          "type": "string",
          "required": false,
          "conditional": true,
          "displayName": "Form Description"
        },
        {
          "name": "formFields",
          "type": "fixedCollection",
          "required": false,
          "conditional": true,
          "displayName": "Form Elements"
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond When",
          "options": [
            "onReceived",
            "lastNode",
            "responseNode"
          ]
        },
        {
          "name": "httpMethod",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "HTTP Method",
          "options": [
            "DELETE",
            "GET",
            "HEAD",
            "PATCH",
            "POST",
            "PUT"
          ]
        },
        {
          "name": "responseCode",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Response Code",
          "min": 100,
          "max": 599
        },
        {
          "name": "responseMode",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Respond",
          "options": [
            "onReceived",
            "lastNode",
            "responseNode"
          ]
        },
        {
          "name": "responseData",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Response Data",
          "options": [
            "allEntries",
            "firstEntryJson",
            "firstEntryBinary",
            "noData"
          ]
        },
        {
          "name": "responseBinaryPropertyName",
          "type": "string",
          "required": true,
          "conditional": true,
          "displayName": "Property Name"
        },
        {
          "name": "limitWaitTime",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Limit Wait Time"
        },
        {
          "name": "limitType",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Limit Type",
          "options": [
            "afterTimeInterval",
            "atSpecifiedTime"
          ]
        },
        {
          "name": "resumeAmount",
          "type": "number",
          "required": false,
          "conditional": true,
          "displayName": "Amount",
          "min": 0
        },
        {
          "name": "resumeUnit",
          "type": "options",
          "required": false,
          "conditional": true,
          "displayName": "Unit",
          "options": [
            "seconds",
            "minutes",
            "hours",
            "days"
          ]
        },
        {
          "name": "maxDateAndTime",
          "type": "dateTime",
          "required": false,
          "conditional": true,
          "displayName": "Max Date and Time"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": true,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "1.1"
    },
    "n8n-nodes-base.noOp": {
      "type": "n8n-nodes-base.noOp",
      "label": "No Operation, do nothing",
      "versions": [
        "1"
      ],
      "parameters": [],
      "defaultVersion": "1"
    },
    "n8n-nodes-base.if": {
      "type": "n8n-nodes-base.if",
      "label": "If",
      "versions": [
        "1",
        "2",
        "2.1",
        "2.2",
        "2.3"
      ],
      "parameters": [
        {
          "name": "conditions",
          "type": "filter",
          "required": false,
          "conditional": false,
          "displayName": "Conditions"
        },
        {
          "name": "looseTypeValidation",
          "type": "boolean",
          "required": false,
          "conditional": true,
          "displayName": "Convert types where required"
        },
        {
          "name": "options",
          "type": "collection",
          "required": false,
          "conditional": false,
          "displayName": "Options"
        }
      ],
      "defaultVersion": "2.3"
    }
  },
  unsupported: [],
};
