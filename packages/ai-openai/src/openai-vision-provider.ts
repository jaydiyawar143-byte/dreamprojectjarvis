// ---------------------------------------------------------------------------
// V3 — image understanding.
//
// Produces a TEXT description of an image so it can flow through the knowledge
// pipeline that already exists. That is the whole design: an image becomes text,
// and from there chunking, embedding, retrieval and citation all work unchanged.
// The alternative — a separate image store with its own retrieval path — would
// duplicate the RAG stack for one file type.
//
// The description is deliberately detailed and literal. It is not written for a
// person to read; it is written to be EMBEDDED and later retrieved, so a
// question like "what is the total on this invoice" has to be answerable from
// the text alone. Vague summaries retrieve badly.
//
// The image is sent as a data URL in the request and is never persisted by this
// module. What gets stored is the description.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import { JarvisError } from "@jarvis/core";

/** Formats the vision model accepts. Anything else is refused before upload. */
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Vision requests are billed per image and are slow; 10MB is a sane ceiling. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface OpenAIVisionConfig {
  apiKey?: string;
  /** Must be a vision-capable model. gpt-4o and gpt-4o-mini both are. */
  model?: string;
  timeoutMs?: number;
}

export interface ImageDescription {
  /** Extracted text and description, for embedding. */
  text: string;
  model: string;
}

export function isSupportedImage(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType.toLowerCase());
}

/**
 * The instruction given to the model.
 *
 * Explicit about transcription because the most common real use is a photo or
 * screenshot of a document — an invoice, a receipt, a slide — where the words
 * in the image are the actual content and a description of "a white document"
 * would be useless.
 */
const SYSTEM_PROMPT = `You describe images so they can be searched later.

Rules:
- Transcribe ALL visible text verbatim, including numbers, dates, totals, labels and headings. This matters more than anything else.
- Preserve table structure as readable rows.
- Then describe what the image shows: objects, people, layout, charts and what they depict.
- State what you cannot read rather than guessing at it.
- Do not speculate about anything not visible.

Write plain prose and transcribed text. No preamble.`;

export class OpenAIVisionProvider {
  private client: OpenAI;
  private model: string;
  private timeoutMs: number;

  constructor(config: OpenAIVisionConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new JarvisError("INVALID_REQUEST", "OPENAI_API_KEY is required for image understanding");
    }
    this.client = new OpenAI({ apiKey });
    // gpt-4o-mini is vision-capable and markedly cheaper; the transcription
    // quality is sufficient for retrieval, which is what this text is for.
    this.model = config.model ?? process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * Describes an image.
   *
   * @param base64 Raw base64, WITHOUT a data-URL prefix.
   */
  async describeImage(
    base64: string,
    mimeType: string,
    question?: string
  ): Promise<ImageDescription> {
    if (!isSupportedImage(mimeType)) {
      throw new JarvisError("INVALID_REQUEST", `Unsupported image type: ${mimeType}`);
    }

    // Base64 encodes 3 bytes per 4 characters; checked before sending so an
    // oversized upload fails locally rather than after a slow round trip.
    const approximateBytes = Math.floor((base64.length * 3) / 4);
    if (approximateBytes > MAX_IMAGE_BYTES) {
      throw new JarvisError("INVALID_REQUEST", "Image exceeds the 10MB limit");
    }

    try {
      const result = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: question
                    ? `Describe this image, then answer: ${question}`
                    : "Describe this image.",
                },
                {
                  type: "image_url",
                  // "high" detail costs more tokens but is what makes small
                  // text in a scanned document legible; transcription is the
                  // primary job here.
                  image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
                },
              ],
            },
          ],
          max_tokens: 2000,
        },
        { timeout: this.timeoutMs }
      );

      const text = result.choices[0]?.message?.content?.trim();
      if (!text) {
        throw new JarvisError("INTERNAL_ERROR", "The vision model returned no description");
      }

      return { text, model: result.model ?? this.model };
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      // The provider's message can echo request content, so it is not
      // forwarded; the server log keeps the detail.
      throw new JarvisError("INTERNAL_ERROR", "Could not analyse the image");
    }
  }
}
