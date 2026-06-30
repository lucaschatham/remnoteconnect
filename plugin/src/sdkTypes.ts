import type { ReactRNPlugin } from "@remnote/plugin-sdk";

export type RemObject = NonNullable<Awaited<ReturnType<ReactRNPlugin["rem"]["findOne"]>>>;
export type CardObject = NonNullable<Awaited<ReturnType<ReactRNPlugin["card"]["findOne"]>>>;
