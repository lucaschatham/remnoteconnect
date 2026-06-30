import type { RichTextInterface } from "@remnote/plugin-sdk";
import type { CardObject, RemObject } from "./sdkTypes.js";
import type { RemSnapshotNode } from "@remnoteconnect/shared";

export type ExecutorContext = {
  rootName: string;
};

export type RemSummary = {
  id: string;
  parentId: string | null;
  text: string;
  backText?: string;
  path: string;
  tags: Array<{ id: string; text: string }>;
  cards: CardSummary[];
  isFolder?: boolean;
  isDocument?: boolean;
  isCardItem?: boolean;
  practiceDirection?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type CardSummary = {
  id: string;
  remId: string;
  type: unknown;
  createdAt?: number;
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  timesWrongInRow?: number;
  repetitionHistory?: unknown;
};

export type ResolvedTarget = {
  rems: RemObject[];
  cards: CardObject[];
};

export type SnapshotBuildOptions = {
  includeCards?: boolean;
};

export type RichTextish = string | unknown[] | Record<string, unknown> | undefined;

export type SnapshotNodeWithRem = RemSnapshotNode & {
  richText?: RichTextInterface;
  richBackText?: RichTextInterface;
};
