import { z } from "zod";

export const TriageResultSchema = z.object({
  need: z.string().min(1),
  is_solution_not_problem: z.boolean(),
  duplicate: z.object({
    verdict: z.enum(["duplicate", "related", "distinct"]),
    matches_id: z.number().int().nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  theme: z.object({
    existing_theme_id: z.number().int().nullable(),
    new_theme_name: z.string().nullable(),
    new_theme_summary: z.string().nullable(),
  }),
  route: z.enum(["product", "engineering", "support", "not_actionable"]),
  scores: z.array(z.object({
    criterion: z.string(),
    score: z.number().int().min(1).max(5),
    rationale: z.string(),
  })),
  needs_clarification: z.string().nullable(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

export const SubmitSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(5000),
  requester: z.string().max(100).optional(),
  source: z.enum(["web", "support", "sales", "internal"]).optional(),
});

export const DraftUpdateSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
});
