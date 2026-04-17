import { prisma } from "./db";
import type { CampaignQuestion } from "@prisma/client";

export const QUESTION_KINDS = [
  "short_text",
  "long_text",
  "single_select",
  "multi_select",
  "number",
  "boolean",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const SHOW_WHEN = ["always", "attending", "declined"] as const;
export type ShowWhen = (typeof SHOW_WHEN)[number];

export type QuestionInput = {
  prompt: string;
  kind: QuestionKind;
  required: boolean;
  options: string | null; // newline-separated for selects
  showWhen: ShowWhen;
};

// Split options into a trimmed list; ignore blank lines. Used by both
// server validation and the public form renderer.
export function parseOptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function listQuestions(campaignId: string) {
  return prisma.campaignQuestion.findMany({
    where: { campaignId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

export async function createQuestion(campaignId: string, input: QuestionInput) {
  const max = await prisma.campaignQuestion.findFirst({
    where: { campaignId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return prisma.campaignQuestion.create({
    data: {
      campaignId,
      order: (max?.order ?? -1) + 1,
      prompt: input.prompt.slice(0, 300),
      kind: input.kind,
      required: input.required,
      options: needsOptions(input.kind) ? (input.options ?? "").slice(0, 2000) : null,
      showWhen: input.showWhen,
    },
  });
}

export async function updateQuestion(
  questionId: string,
  campaignId: string,
  input: QuestionInput,
) {
  await prisma.campaignQuestion.updateMany({
    where: { id: questionId, campaignId },
    data: {
      prompt: input.prompt.slice(0, 300),
      kind: input.kind,
      required: input.required,
      options: needsOptions(input.kind) ? (input.options ?? "").slice(0, 2000) : null,
      showWhen: input.showWhen,
    },
  });
}

export async function deleteQuestion(questionId: string, campaignId: string) {
  await prisma.campaignQuestion.deleteMany({ where: { id: questionId, campaignId } });
}

export async function reorderQuestions(campaignId: string, orderedIds: string[]) {
  await prisma.$transaction(
    orderedIds.map((id, idx) =>
      prisma.campaignQuestion.updateMany({
        where: { id, campaignId },
        data: { order: idx },
      }),
    ),
  );
}

export function needsOptions(kind: QuestionKind): boolean {
  return kind === "single_select" || kind === "multi_select";
}

// Filter questions that apply for this response's state. Used on the public
// RSVP page to show only relevant questions, and in the admin view to pair
// questions with the answers that were captured.
export function filterForState(questions: CampaignQuestion[], attending: boolean | null): CampaignQuestion[] {
  return questions.filter((q) => {
    if (q.showWhen === "always") return true;
    if (attending === null) return false;
    return q.showWhen === (attending ? "attending" : "declined");
  });
}

// Validate + coerce submitted answers against the question definitions.
// Returns `{ ok, answers }` on success or `{ ok: false, errors }` keyed by questionId.
export function validateAnswers(
  questions: CampaignQuestion[],
  raw: Record<string, string | string[]>,
):
  | { ok: true; answers: Array<{ questionId: string; value: string }> }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const answers: Array<{ questionId: string; value: string }> = [];
  for (const q of questions) {
    const input = raw[q.id];
    const isEmpty = input == null || (Array.isArray(input) ? input.length === 0 : input.trim() === "");
    if (isEmpty) {
      if (q.required) errors[q.id] = "required";
      continue;
    }
    let value: string;
    switch (q.kind as QuestionKind) {
      case "short_text":
      case "long_text":
        value = String(input).slice(0, q.kind === "short_text" ? 300 : 5000);
        break;
      case "number": {
        const n = Number(input);
        if (!Number.isFinite(n)) { errors[q.id] = "invalid_number"; continue; }
        value = String(n);
        break;
      }
      case "boolean": {
        const s = String(input).toLowerCase();
        value = s === "true" || s === "yes" || s === "on" || s === "1" ? "true" : "false";
        break;
      }
      case "single_select": {
        const s = String(input);
        const opts = parseOptions(q.options);
        if (!opts.includes(s)) { errors[q.id] = "invalid_choice"; continue; }
        value = s;
        break;
      }
      case "multi_select": {
        const picked = Array.isArray(input) ? input : [input];
        const opts = new Set(parseOptions(q.options));
        const valid = picked.filter((p) => opts.has(p));
        if (q.required && valid.length === 0) { errors[q.id] = "required"; continue; }
        value = valid.join("\n");
        break;
      }
      default:
        continue;
    }
    answers.push({ questionId: q.id, value });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, answers };
}
