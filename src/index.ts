#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'path'; // Need path for dotenv

// Load .env file from the current working directory (where bunx/node is run)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance, AxiosError } from 'axios';
import fs from 'fs/promises'; // Import file system module

// --- Configuration ---
const UNSPLASH_API_KEY = process.env.UNSPLASH_ACCESS_KEY;
const UNSPLASH_API_BASE_URL = 'https://api.unsplash.com';
const SERVER_NAME = 'unsplash-mcp-server';
const SERVER_VERSION = '0.1.1'; // Incremented version
const DOWNLOAD_DIR = 'unsplash'; // Subdirectory for downloads

if (!UNSPLASH_API_KEY) {
  console.error(
    'FATAL: UNSPLASH_ACCESS_KEY environment variable is not set. Please configure it in the MCP settings.'
  );
  process.exit(1);
}

// --- Unsplash API Interfaces (Partial) ---
interface UnsplashPhotoUrls {
  raw: string;
  full: string;
  regular: string;
  small: string;
  thumb: string;
}

interface UnsplashPhotoLinks {
  self: string;
  html: string;
  download: string;
  download_location: string;
}

interface UnsplashUser {
  id: string;
  username: string;
  name: string;
  links: {
    html: string;
  };
}

interface UnsplashPhoto {
  id: string;
  description: string | null;
  alt_description: string | null;
  urls: UnsplashPhotoUrls;
  links: UnsplashPhotoLinks;
  user: UnsplashUser;
  width: number;
  height: number;
  color: string | null;
  blur_hash: string | null;
}

interface UnsplashSearchResponse {
  total: number;
  total_pages: number;
  results: UnsplashPhoto[];
}

// --- Tool Input Validation ---
type PhotoResolution = 'raw' | 'full' | 'regular' | 'small';

interface SearchPhotosArgs {
  query: string;
  page?: number;
  per_page?: number;
  orientation?: 'landscape' | 'portrait' | 'squarish';
}

interface TriggerDownloadArgs {
  download_location_url: string;
}

interface DownloadPhotoArgs {
  photo_id: string;
  resolution?: PhotoResolution;
  filename?: string;
}

function isValidSearchArgs(args: any): args is SearchPhotosArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.query === 'string' &&
    (args.page === undefined || typeof args.page === 'number') &&
    (args.per_page === undefined || typeof args.per_page === 'number') &&
    (args.orientation === undefined ||
      ['landscape', 'portrait', 'squarish'].includes(args.orientation))
  );
}

function isValidTriggerArgs(args: any): args is TriggerDownloadArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.download_location_url === 'string' &&
    args.download_location_url.startsWith('https://api.unsplash.com/photos/')
  );
}

function isValidDownloadArgs(args: any): args is DownloadPhotoArgs {
    const validResolutions: PhotoResolution[] = ['raw', 'full', 'regular', 'small'];
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.photo_id === 'string' &&
    (args.resolution === undefined || validResolutions.includes(args.resolution)) &&
    (args.filename === undefined || typeof args.filename === 'string')
  );
}
 
// Helper function to sanitize description for filename
function sanitizeFilename(name: string | null | undefined): string {
  if (!name) return '';
  // Remove invalid characters, replace spaces with underscores, limit length
  const sanitized = name
    .replace(/[\/\\:*?"<>|]/g, '') // Remove invalid chars
    .replace(/\s+/g, '_')          // Replace whitespace with underscore
    .substring(0, 100);           // Limit length
  return sanitized.trim() || ''; // Return trimmed or empty string if only whitespace after sanitize
}
 
// --- MCP Server Implementation ---
class UnsplashServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  // Store workspace path if provided by client (optional enhancement)
  private workspaceRoot: string = process.cwd(); // Default to current working directory

  constructor() {
    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        description: 'MCP server for searching and downloading Unsplash images.',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: UNSPLASH_API_BASE_URL,
      headers: {
        Authorization: `Client-ID ${UNSPLASH_API_KEY}`,
        'Accept-Version': 'v1',
      },
    });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error(`[${SERVER_NAME} Error]`, error);
    process.on('SIGINT', async () => {
      console.error(`[${SERVER_NAME}] Received SIGINT, shutting down...`);
      await this.server.close();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      console.error(`[${SERVER_NAME}] Received SIGTERM, shutting down...`);
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    const tools = [
      {
        name: 'search_photos',
        description: 'Searches for photos on Unsplash. Returns JSON data and a formatted text summary with image links.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search term(s).' },
            page: { type: 'number', description: 'Page number (default: 1).', default: 1 },
            per_page: { type: 'number', description: 'Items per page (default: 10, max: 30).', default: 10, maximum: 30 },
            orientation: { type: 'string', enum: ['landscape', 'portrait', 'squarish'], description: 'Filter by orientation.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'download_photo', // Handles both tracking and download
        description: 'Downloads an Unsplash photo to the workspace\'s "unsplash" folder after triggering the download tracking event.',
        inputSchema: {
            type: 'object',
            properties: {
                photo_id: { type: 'string', description: 'The ID of the photo to download.'},
                resolution: { type: 'string', enum: ['raw', 'full', 'regular', 'small'], description: 'Desired resolution (default: raw).', default: 'raw'}, // Default changed to 'raw'
                filename: { type: 'string', description: 'Optional filename (e.g., my-image.jpg). Defaults to sanitized description or {photo_id}.jpg.'} // Description updated
            },
            required: ['photo_id'],
        }
      }
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === 'search_photos') {
          if (!isValidSearchArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid search arguments');
          return await this.handleSearchPhotos(args);
        } else if (name === 'download_photo') {
            if (!isValidDownloadArgs(args)) throw new McpError(ErrorCode.InvalidParams, 'Invalid download_photo arguments');
            return await this.handleDownloadPhoto(args);
        }
        else {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`[${SERVER_NAME}] Error calling tool ${name}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          const apiMessage = (axiosError.response?.data as any)?.errors?.join(', ') || axiosError.message;
          const statusText = axiosError.response?.statusText || 'Error';
          throw new McpError(ErrorCode.InternalError, `Unsplash API Error (${axiosError.response?.status} ${statusText}): ${apiMessage}`);
        }
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, errorMessage);
      }
    });
  }

  // --- Tool Logic Implementation ---

  private async handleSearchPhotos(args: SearchPhotosArgs) {
    const response = await this.axiosInstance.get<UnsplashSearchResponse>(
      '/search/photos',
      { params: { ...args } } // Pass validated args directly
    );

    const simplifiedResults = response.data.results.map((photo) => ({
      id: photo.id,
      description: photo.description || photo.alt_description,
      width: photo.width,
      height: photo.height,
      urls: { small: photo.urls.small, regular: photo.urls.regular, full: photo.urls.full, raw: photo.urls.raw },
      links: { html: photo.links.html, download_location: photo.links.download_location },
      user: { name: photo.user.name, profile_url: photo.user.links.html },
    }));

    // Create formatted text summary
    let summaryText = `Found ${response.data.total} photos (Page ${args.page ?? 1}/${response.data.total_pages}):\n\n`;
    simplifiedResults.forEach(photo => {
        const desc = photo.description || 'No description';
        summaryText += `**ID:** ${photo.id}\n`;
        summaryText += `**Description:** ${desc}\n`;
        summaryText += `**By:** [${photo.user.name}](${photo.user.profile_url}?utm_source=${SERVER_NAME}&utm_medium=referral)\n`;
        summaryText += `**Preview:** ![${desc}](${photo.urls.small})\n`; // Markdown image link
        summaryText += `**Link:** ${photo.links.html}\n\n`;
    });

    const content = [ // Removed incorrect type annotation ': Content[]'
      {
        type: 'text', // Primary content is still text (JSON)
        text: JSON.stringify({ // Full data
          total: response.data.total,
          total_pages: response.data.total_pages,
          results: simplifiedResults,
        }, null, 2),
      },
      {
        type: 'text', // Secondary content is the formatted summary
        text: summaryText,
  },
];

return { content }; // Type is inferred correctly here based on array elements
}
 
  // Removed handleTriggerDownload as it's incorporated into handleDownloadPhoto
 
  private async handleDownloadPhoto(args: DownloadPhotoArgs) {
    // 1. Get photo details to find URLs
    const photoDetailsResponse = await this.axiosInstance.get<UnsplashPhoto>(`/photos/${args.photo_id}`);
    const photo = photoDetailsResponse.data;
    const downloadLocationUrl = photo.links.download_location;
    const resolution = args.resolution || 'raw'; // Default resolution changed to 'raw'
    const imageUrl = photo.urls[resolution];

    if (!imageUrl) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid resolution '${resolution}' for photo ${args.photo_id}.`);
    }

    // 2. Trigger download tracking (fire and forget, but check for errors)
    try {
        await this.axiosInstance.get(downloadLocationUrl);
        console.log(`[${SERVER_NAME}] Triggered download track for ${args.photo_id}`);
    } catch (trackError) {
         console.error(`[${SERVER_NAME}] Failed to trigger download track for ${args.photo_id}:`, trackError instanceof Error ? trackError.message : trackError);
         // Continue with download even if tracking fails, but log it.
    }

    // 3. Download the actual image
    console.log(`[${SERVER_NAME}] Downloading ${resolution} image for ${args.photo_id} from ${imageUrl}`);
    const imageResponse = await this.axiosInstance.get(imageUrl, {
        responseType: 'arraybuffer' // Crucial for binary data
    });

    // 4. Determine filename and path
    let baseFilename = args.filename;
    if (!baseFilename) {
        const sanitizedDesc = sanitizeFilename(photo.description || photo.alt_description);
        baseFilename = sanitizedDesc ? `${sanitizedDesc}.jpg` : `${args.photo_id}.jpg`;
    }
    // Ensure filename has an extension if user provided one without it
    if (baseFilename && !path.extname(baseFilename)) {
        baseFilename += '.jpg'; // Assume jpg if no extension
    }
    const filename = baseFilename; // Final filename
 
    const downloadDirPath = path.join(this.workspaceRoot, DOWNLOAD_DIR);
    const filePath = path.join(downloadDirPath, filename);

    // 5. Ensure directory exists
    await fs.mkdir(downloadDirPath, { recursive: true });

    // 6. Save the image
    await fs.writeFile(filePath, imageResponse.data);
    console.log(`[${SERVER_NAME}] Saved image to ${filePath}`);

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Photo downloaded successfully to ${DOWNLOAD_DIR}/${filename}` }) }],
    };
  }


  // --- Server Start ---
  async run() {
    const transport = new StdioServerTransport();
    // Listen for workspace root message from client (optional enhancement)
    transport.onmessage = (message: unknown) => { // Use 'unknown' for better type safety initially
      // More robust type guard for JSON-RPC Notification
      if (
        typeof message === 'object' &&
        message !== null &&
        'method' in message &&
        typeof (message as { method: unknown }).method === 'string' &&
        (message as { method: string }).method === '$/setWorkspaceRoot' &&
        'params' in message &&
        typeof (message as { params: unknown }).params === 'object' &&
        (message as { params: object | null }).params !== null &&
        'workspaceRoot' in (message as { params: object }).params &&
        typeof ((message as { params: { workspaceRoot: unknown } }).params.workspaceRoot) === 'string'
      ) {
        // Now TypeScript knows message.params.workspaceRoot is a string
        this.workspaceRoot = (message as { params: { workspaceRoot: string } }).params.workspaceRoot;
        console.error(`[${SERVER_NAME}] Workspace root set to: ${this.workspaceRoot}`); // Reverted to original log
      }
    };
    await this.server.connect(transport);
    console.error(`[${SERVER_NAME}] MCP server running on stdio`);
  }
}

// --- Instantiate and Run ---
const server = new UnsplashServer();
server.run().catch((error) => {
  console.error(`[${SERVER_NAME}] Failed to start server:`, error);
  process.exit(1);
});
