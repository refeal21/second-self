export interface VisualStyleProfile {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  accentColors: string[];
  instructions: string;
  template: { fileName: string; sha256: string; relativePath: string } | null;
}

export interface VisualStyleState {
  revision: number;
  profile: VisualStyleProfile | null;
  locked: boolean;
}

export interface TemplateStyleInspection {
  colors: Array<{ color: string; count: number }>;
  slideCount: number;
  warnings: string[];
}

export interface VisualGenerationRequest {
  id: string;
  projectId: string;
  expectedRevision: number;
  styleRevision: number;
  slideId: string;
  kind: 'imagegen' | 'upload';
  prompt: string;
  feedback: string;
  promptVersion: string;
}

export interface VisualGenerationRecord extends VisualGenerationRequest {
  createdAt: string;
  promptSha256: string;
  specSha256: string;
  style: VisualStyleState;
  receipt: null | {
    relativePath: string;
    sha256: string;
    committedRevision: number;
    createdAt: string;
    provider: { threadId?: string; turnId?: string; itemId?: string };
  };
}

const PROFILE_FIELDS = [
  'primaryColor',
  'backgroundColor',
  'textColor',
  'accentColors',
  'instructions',
  'template',
] as const;
const STATE_FIELDS = ['revision', 'profile', 'locked'] as const;
const REQUEST_FIELDS = [
  'id',
  'projectId',
  'expectedRevision',
  'styleRevision',
  'slideId',
  'kind',
  'prompt',
  'feedback',
  'promptVersion',
] as const;
const RECORD_FIELDS = [
  ...REQUEST_FIELDS,
  'createdAt',
  'promptSha256',
  'specSha256',
  'style',
  'receipt',
] as const;
const MAX_ACCENT_COLORS = 8;
const MAX_INSTRUCTION_CHARACTERS = 4_000;
const MAX_PROMPT_BYTES = 192 * 1024;
const MAX_FEEDBACK_BYTES = 16 * 1024;

export function parseVisualStyleProfile(value: unknown): VisualStyleProfile {
  const input = object(value, 'visual style profile');
  exactFields(input, PROFILE_FIELDS, 'visual style profile');
  const primaryColor = color(input.primaryColor, 'primaryColor');
  const backgroundColor = color(input.backgroundColor, 'backgroundColor');
  const textColor = color(input.textColor, 'textColor');
  if (!Array.isArray(input.accentColors) || input.accentColors.length > MAX_ACCENT_COLORS) {
    invalid('visual style profile accentColors must contain at most eight colors');
  }
  const accentColors = input.accentColors.map((item, index) =>
    color(item, `accentColors[${index}]`));
  const instructions = boundedString(
    input.instructions,
    'visual style profile instructions',
    MAX_INSTRUCTION_CHARACTERS,
  );
  let template: VisualStyleProfile['template'] = null;
  if (input.template !== null) {
    const candidate = object(input.template, 'visual style template');
    exactFields(candidate, ['fileName', 'sha256', 'relativePath'], 'visual style template');
    const fileName = boundedString(candidate.fileName, 'visual style template fileName', 255);
    if (fileName === '.' || fileName === '..' || /[/\\]/u.test(fileName) || !/\.pptx$/iu.test(fileName)) {
      invalid('visual style template fileName must be a local PPTX basename');
    }
    const sha256 = sha(candidate.sha256, 'visual style template sha256');
    const relativePath = boundedString(candidate.relativePath, 'visual style template relativePath', 160);
    if (relativePath !== `visuals/style-templates/${sha256}.pptx`) {
      invalid('visual style template relativePath must be derived from sha256');
    }
    template = { fileName, sha256, relativePath };
  }
  return {
    primaryColor,
    backgroundColor,
    textColor,
    accentColors,
    instructions,
    template,
  };
}

export function parseVisualStyleState(value: unknown): VisualStyleState {
  const input = object(value, 'visual style state');
  exactFields(input, STATE_FIELDS, 'visual style state');
  const parsedRevision = safeRevision(input.revision, 'visual style state revision');
  if (typeof input.locked !== 'boolean') invalid('visual style state locked must be boolean');
  return {
    revision: parsedRevision,
    profile: input.profile === null ? null : parseVisualStyleProfile(input.profile),
    locked: input.locked,
  };
}

export function parseVisualGenerationRequest(value: unknown): VisualGenerationRequest {
  const input = object(value, 'visual generation request');
  exactFields(input, REQUEST_FIELDS, 'visual generation request');
  return parseRequestFields(input);
}

export function parseVisualGenerationRecord(value: unknown): VisualGenerationRecord {
  const input = object(value, 'visual generation record');
  exactFields(input, RECORD_FIELDS, 'visual generation record');
  const request = parseRequestFields(input);
  const createdAt = shortNonempty(input.createdAt, 'visual generation record createdAt', 64);
  const promptSha256 = sha(input.promptSha256, 'visual generation record promptSha256');
  const specSha256 = sha(input.specSha256, 'visual generation record specSha256');
  const style = parseVisualStyleState(input.style);
  let receipt: VisualGenerationRecord['receipt'] = null;
  if (input.receipt !== null) {
    const candidate = object(input.receipt, 'visual generation record receipt');
    exactFields(
      candidate,
      ['relativePath', 'sha256', 'committedRevision', 'createdAt', 'provider'],
      'visual generation record receipt',
    );
    const relativePath = safeRelativePath(
      candidate.relativePath,
      'visual generation record receipt relativePath',
    );
    const providerInput = object(candidate.provider, 'visual generation record receipt provider');
    allowedFields(providerInput, ['threadId', 'turnId', 'itemId'], 'visual generation record receipt provider');
    const provider: NonNullable<VisualGenerationRecord['receipt']>['provider'] = {};
    for (const field of ['threadId', 'turnId', 'itemId'] as const) {
      if (providerInput[field] !== undefined) {
        provider[field] = shortNonempty(
          providerInput[field],
          `visual generation record receipt provider ${field}`,
          256,
        );
      }
    }
    receipt = {
      relativePath,
      sha256: sha(candidate.sha256, 'visual generation record receipt sha256'),
      committedRevision: safeRevision(
        candidate.committedRevision,
        'visual generation record receipt committedRevision',
      ),
      createdAt: shortNonempty(
        candidate.createdAt,
        'visual generation record receipt createdAt',
        64,
      ),
      provider,
    };
  }
  return { ...request, createdAt, promptSha256, specSha256, style, receipt };
}

function parseRequestFields(input: Record<string, unknown>): VisualGenerationRequest {
  const kind = input.kind;
  if (kind !== 'imagegen' && kind !== 'upload') {
    invalid('visual generation request kind must be imagegen or upload');
  }
  const prompt = byteBoundedString(
    input.prompt,
    'visual generation request prompt',
    MAX_PROMPT_BYTES,
    kind === 'upload',
  );
  const feedback = byteBoundedString(input.feedback, 'visual generation request feedback', MAX_FEEDBACK_BYTES, true);
  return {
    id: shortNonempty(input.id, 'visual generation request id', 128),
    projectId: shortNonempty(input.projectId, 'visual generation request projectId', 128),
    expectedRevision: safeRevision(input.expectedRevision, 'visual generation request expectedRevision'),
    styleRevision: safeRevision(input.styleRevision, 'visual generation request styleRevision'),
    slideId: shortNonempty(input.slideId, 'visual generation request slideId', 128),
    kind,
    prompt,
    feedback,
    promptVersion: shortNonempty(input.promptVersion, 'visual generation request promptVersion', 128),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    invalid(`${path} contains an unsupported field`);
  }
  if (fields.some((key) => !(key in value))) {
    invalid(`${path} is missing a required field`);
  }
}

function allowedFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    invalid(`${path} contains an unsupported field`);
  }
}

function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    invalid(`visual style profile ${path} must be #RRGGBB`);
  }
  return value;
}

function boundedString(value: unknown, path: string, maxCharacters: number): string {
  if (typeof value !== 'string' || Array.from(value).length > maxCharacters) {
    invalid(`${path} is invalid or too long`);
  }
  return value;
}

function byteBoundedString(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || new TextEncoder().encode(value).byteLength > maxBytes) {
    invalid(`${path} is invalid or too large`);
  }
  return value;
}

function shortNonempty(value: unknown, path: string, maxCharacters: number): string {
  const result = boundedString(value, path, maxCharacters);
  if (result.length === 0) invalid(`${path} must not be empty`);
  return result;
}

function sha(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    invalid(`${path} must be a lowercase SHA-256`);
  }
  return value;
}

function safeRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeRelativePath(value: unknown, path: string): string {
  const result = shortNonempty(value, path, 512);
  if (result.startsWith('/') || result.includes('\\')
    || result.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    invalid(`${path} must be a safe project-relative path`);
  }
  return result;
}

function invalid(message: string): never {
  throw new Error(message);
}
