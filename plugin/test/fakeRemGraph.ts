import type { ReactRNPlugin } from "@remnote/plugin-sdk";

type PracticeDirection = "forward" | "backward" | "none" | "both";

export class FakeCard {
  readonly _id: string;
  readonly remId: string;
  type = "front-back";
  createdAt = Date.now();
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  timesWrongInRow = 0;
  repetitionHistory: unknown[] = [];
  removed = false;
  score?: number;

  constructor(private readonly graph: FakeRemGraph, remId: string) {
    this.remId = remId;
    this._id = graph.nextId("card");
  }

  async remove(): Promise<void> {
    this.removed = true;
    this.graph.cards.delete(this._id);
    const rem = this.graph.rems.get(this.remId);
    if (rem) rem.cards = rem.cards.filter((card) => card._id !== this._id);
  }

  async updateCardRepetitionStatus(score: number): Promise<void> {
    this.score = score;
    this.lastRepetitionTime = Date.now();
    this.repetitionHistory.push({ score });
  }
}

export class FakeRem {
  readonly _id: string;
  parent: string | null = null;
  text = "";
  backText = "";
  createdAt = Date.now();
  updatedAt = Date.now();
  cards: FakeCard[] = [];
  tags: FakeRem[] = [];
  powerupProperties = new Map<string, string>();
  tagProperties = new Map<string, string | undefined>();
  portalIds: string[] = [];
  removed = false;
  folder = false;
  document = false;
  cardItem = false;
  practiceEnabled = false;
  practiceDirection: PracticeDirection = "none";
  private getCardsReads = 0;

  constructor(private readonly graph: FakeRemGraph, text = "") {
    this._id = graph.nextId("rem");
    this.text = text;
  }

  async setParent(parent: FakeRem | null, positionAmongstSiblings?: number): Promise<void> {
    this.graph.moveInOrder(this._id, this.parent, parent?._id ?? null, positionAmongstSiblings);
    this.parent = parent?._id ?? null;
    this.updatedAt = Date.now();
  }

  async getParentRem(): Promise<FakeRem | undefined> {
    return this.parent ? this.graph.rems.get(this.parent) : undefined;
  }

  async getChildrenRem(): Promise<FakeRem[]> {
    return this.graph.childrenOf(this._id);
  }

  async getDescendants(): Promise<FakeRem[]> {
    const children = await this.getChildrenRem();
    const descendants: FakeRem[] = [];
    for (const child of children) {
      descendants.push(child, ...(await child.getDescendants()));
    }
    return descendants;
  }

  async setText(value: unknown): Promise<void> {
    this.text = this.graph.richTextToString(value);
    this.updatedAt = Date.now();
  }

  async setBackText(value: unknown): Promise<void> {
    this.backText = this.graph.richTextToString(value);
    this.updatedAt = Date.now();
  }

  async setEnablePractice(enabled: boolean): Promise<void> {
    this.practiceEnabled = enabled;
    if (!enabled) this.cards = [];
  }

  async setPracticeDirection(direction: PracticeDirection): Promise<void> {
    this.practiceDirection = direction;
  }

  async getPracticeDirection(): Promise<PracticeDirection> {
    return this.practiceDirection;
  }

  async getCards(): Promise<FakeCard[]> {
    this.getCardsReads += 1;
    if (this.practiceEnabled && this.cards.length === 0 && this.getCardsReads > this.graph.cardMaterializeAfterReads) {
      const card = new FakeCard(this.graph, this._id);
      this.cards.push(card);
      this.graph.cards.set(card._id, card);
    }
    return this.cards.filter((card) => !card.removed);
  }

  async getTagRems(): Promise<FakeRem[]> {
    return this.tags.filter((tag) => !tag.removed);
  }

  async addTag(tag: FakeRem): Promise<void> {
    if (!this.tags.some((existing) => existing._id === tag._id)) this.tags.push(tag);
  }

  async removeTag(tagId: string): Promise<void> {
    this.tags = this.tags.filter((tag) => tag._id !== tagId);
  }

  async addPowerup(_powerupCode: string): Promise<void> {
    // Powerup existence is implicit in the property map for tests.
  }

  async setPowerupProperty(powerupCode: string, slot: string, value: unknown): Promise<void> {
    this.powerupProperties.set(`${powerupCode}:${slot}`, this.graph.richTextToString(value));
  }

  async getPowerupPropertyAsRichText(powerupCode: string, slot: string): Promise<string> {
    return this.powerupProperties.get(`${powerupCode}:${slot}`) ?? "";
  }

  async getPowerupProperty(powerupCode: string, slot: string): Promise<string> {
    return this.powerupProperties.get(`${powerupCode}:${slot}`) ?? "";
  }

  async setTagPropertyValue(propertyId: string, value: unknown): Promise<void> {
    this.tagProperties.set(propertyId, value === undefined ? undefined : this.graph.richTextToString(value));
  }

  async getTagPropertyValue(propertyId: string): Promise<string | undefined> {
    return this.tagProperties.get(propertyId);
  }

  async addToPortal(portal: FakeRem | string): Promise<void> {
    const portalId = typeof portal === "string" ? portal : portal._id;
    if (!this.portalIds.includes(portalId)) this.portalIds.push(portalId);
  }

  async isFolder(): Promise<boolean> {
    return this.folder;
  }

  async isDocument(): Promise<boolean> {
    return this.document;
  }

  async isCardItem(): Promise<boolean> {
    return this.cardItem;
  }

  async setIsFolder(value: boolean): Promise<void> {
    this.folder = value;
  }

  async setIsDocument(value: boolean): Promise<void> {
    this.document = value;
  }

  async setIsCardItem(value: boolean): Promise<void> {
    this.cardItem = value;
  }

  async remsReferencingThis(): Promise<FakeRem[]> {
    return [...this.graph.rems.values()].filter(
      (rem) => !rem.removed && rem._id !== this._id && (rem.text.includes(this.graph.reference(this._id)) || rem.backText.includes(this.graph.reference(this._id))),
    );
  }

  async remove(): Promise<void> {
    for (const child of await this.getChildrenRem()) await child.remove();
    for (const card of [...this.cards]) await card.remove();
    this.removed = true;
    this.graph.removeFromOrder(this._id, this.parent);
    this.graph.rems.delete(this._id);
  }
}

export class FakeRemGraph {
  readonly rems = new Map<string, FakeRem>();
  readonly cards = new Map<string, FakeCard>();
  readonly order = new Map<string, string[]>();
  readonly plugin: ReactRNPlugin;
  readonly root: FakeRem;
  cardMaterializeAfterReads = 0;
  private sequence = 0;

  constructor() {
    this.root = this.createTopLevel("RemNoteConnect");
    this.plugin = {
      richText: {
        text: (value: string, formats?: string[]) => this.richTextBuilder(`${formats?.length ? `[${formats.join(",")}]` : ""}${value}`),
        rem: (rem: FakeRem | string) => this.richTextBuilder(this.reference(typeof rem === "string" ? rem : rem._id)),
        latex: (value: string, block?: boolean) => this.richTextBuilder(block ? `$$${value}$$` : `$${value}$`),
        image: (url: string) => this.richTextBuilder(`![image](${url})`),
        code: (value: string, language?: string) => this.richTextBuilder(`\`\`\`${language ?? ""}\n${value}\n\`\`\``),
        toString: async (value: unknown) => this.richTextToString(value),
        toMarkdown: async (value: unknown) => this.richTextToString(value),
        parseFromMarkdown: async (value: string) => value,
        replaceAllRichText: async (richText: unknown, findText: unknown, replacementText: unknown) =>
          this.richTextToString(richText).split(this.richTextToString(findText)).join(this.richTextToString(replacementText)),
      },
      rem: {
        createRem: async () => this.createTopLevel(""),
        findOne: async (id?: string) => (id ? this.rems.get(id) ?? null : null),
        findByName: async (name: unknown, parentId: string | null) => {
          const text = this.richTextToString(name);
          return [...this.rems.values()].find((rem) => !rem.removed && rem.parent === parentId && rem.text === text) ?? null;
        },
        getAll: async () => [...this.rems.values()],
        createTreeWithMarkdown: async (markdown: string, parentId?: string) => this.createTreeWithMarkdown(markdown, parentId),
      },
      card: {
        findOne: async (id?: string) => (id ? this.cards.get(id) ?? null : null),
        getAll: async () => [...this.cards.values()],
      },
    } as unknown as ReactRNPlugin;
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  richTextToString(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((part) => this.richTextToString(part)).join("");
    if (value && typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "");
    return String(value ?? "");
  }

  reference(id: string): string {
    return `[[${id}]]`;
  }

  richTextBuilder(initial = "") {
    let value = initial;
    const builder = {
      text: (text: string, formats?: string[]) => {
        value += `${formats?.length ? `[${formats.join(",")}]` : ""}${text}`;
        return builder;
      },
      rem: (rem: FakeRem | string) => {
        value += this.reference(typeof rem === "string" ? rem : rem._id);
        return builder;
      },
      latex: (text: string, block?: boolean) => {
        value += block ? `$$${text}$$` : `$${text}$`;
        return builder;
      },
      image: (url: string) => {
        value += `![image](${url})`;
        return builder;
      },
      code: (text: string, language?: string) => {
        value += `\`\`\`${language ?? ""}\n${text}\n\`\`\``;
        return builder;
      },
      newline: () => {
        value += "\n";
        return builder;
      },
      value: () => value,
    };
    return builder;
  }

  createTopLevel(text: string): FakeRem {
    const rem = new FakeRem(this, text);
    this.rems.set(rem._id, rem);
    this.addToOrder(rem._id, null);
    return rem;
  }

  async createChild(parent: FakeRem, text: string): Promise<FakeRem> {
    const rem = this.createTopLevel(text);
    await rem.setParent(parent);
    return rem;
  }

  parentKey(parentId: string | null): string {
    return parentId ?? "__top__";
  }

  childrenOf(parentId: string | null): FakeRem[] {
    return (this.order.get(this.parentKey(parentId)) ?? [])
      .map((id) => this.rems.get(id))
      .filter((rem): rem is FakeRem => Boolean(rem && !rem.removed && rem.parent === parentId));
  }

  addToOrder(id: string, parentId: string | null, positionAmongstSiblings?: number): void {
    const key = this.parentKey(parentId);
    const siblings = (this.order.get(key) ?? []).filter((existing) => existing !== id);
    const position = positionAmongstSiblings === undefined ? siblings.length : Math.max(0, Math.min(positionAmongstSiblings, siblings.length));
    siblings.splice(position, 0, id);
    this.order.set(key, siblings);
  }

  removeFromOrder(id: string, parentId: string | null): void {
    const key = this.parentKey(parentId);
    this.order.set(key, (this.order.get(key) ?? []).filter((existing) => existing !== id));
  }

  moveInOrder(id: string, oldParentId: string | null, newParentId: string | null, positionAmongstSiblings?: number): void {
    this.removeFromOrder(id, oldParentId);
    this.addToOrder(id, newParentId, positionAmongstSiblings);
  }

  async createTreeWithMarkdown(markdown: string, parentId?: string): Promise<FakeRem[]> {
    const parent = parentId ? this.rems.get(parentId) : undefined;
    const created: FakeRem[] = [];
    const stack: Array<{ indent: number; rem: FakeRem }> = [];
    for (const rawLine of markdown.split("\n")) {
      if (!rawLine.trim()) continue;
      const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
      const text = rawLine.trim().replace(/^[-*]\s+/, "");
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const lineParent = stack[stack.length - 1]?.rem ?? parent;
      const rem = lineParent ? await this.createChild(lineParent, text) : this.createTopLevel(text);
      created.push(rem);
      stack.push({ indent, rem });
    }
    return created;
  }
}
