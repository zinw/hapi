import { trimIdent } from "@/utils/trimIdent";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "mcp__hapi__change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    When you create or find a local image file that the user should see, call the tool "mcp__hapi__display_image" with the image path so HAPI can show it inline.
`))();

export const systemPrompt = BASE_SYSTEM_PROMPT;
