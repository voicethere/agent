import { describe, expect, it } from "vitest";

import {
  LINK_MARK,
  LinkExtractor,
  cleanLinkSentence,
  countLinkMarks,
  type ExtractedLink,
} from "../../../src/llm/agent/link-extractor.js";
import { SentenceSplitter } from "../../../src/llm/agent/sentence-splitter.js";

/** Streams `deltas` through extractor + splitter + cleaner, like the agent does. */
function run(deltas: string[]): {
  sentences: string[];
  links: ExtractedLink[];
} {
  const x = new LinkExtractor();
  const splitter = new SentenceSplitter();
  const raw: string[] = [];
  for (const d of deltas) raw.push(...splitter.push(x.push(d)));
  raw.push(...splitter.push(x.end()), ...splitter.end());
  const sentences: string[] = [];
  const links: ExtractedLink[] = [];
  for (const s of raw) {
    for (let i = 0; i < countLinkMarks(s); i += 1) links.push(x.takeLink()!);
    const clean = cleanLinkSentence(s);
    if (clean) sentences.push(clean);
  }
  expect(x.takeAll()).toEqual([]);
  return { sentences, links };
}

function chars(text: string): string[] {
  return [...text];
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const URL = "https://app.voicethere.dev/docs/pricing";

describe("LinkExtractor", () => {
  for (const [name, split] of [
    ["one delta", (t: string) => [t]],
    ["char by char", chars],
    ["chunks of 7", (t: string) => chunks(t, 7)],
  ] as const) {
    describe(name, () => {
      it("removes a bare URL mid-sentence", () => {
        const r = run(
          split(
            `Plans start at 16 dollars, see ${URL} for details. Anything else?`,
          ),
        );
        expect(r.sentences).toEqual([
          "Plans start at 16 dollars, see for details.",
          "Anything else?",
        ]);
        expect(r.links).toEqual([{ url: URL, secure: true }]);
      });

      it("gives a trailing period back to the sentence", () => {
        const r = run(
          split(`The Advanced plan is 45 dollars a month. Details: ${URL}.`),
        );
        expect(r.sentences).toEqual([
          "The Advanced plan is 45 dollars a month.",
        ]);
        expect(r.links).toEqual([{ url: URL, secure: true }]);
      });

      it("keeps a markdown label in the text and the link", () => {
        const r = run(
          split(`Read the [pricing page](${URL}) for the full list.`),
        );
        expect(r.sentences).toEqual([
          "Read the pricing page for the full list.",
        ]);
        expect(r.links).toEqual([
          { url: URL, label: "pricing page", secure: true },
        ]);
      });

      it("strips an http link from speech and marks it insecure", () => {
        const r = run(
          split("Old docs are at http://example.com/docs. Thanks."),
        );
        expect(r.sentences).toEqual(["Old docs are.", "Thanks."]);
        expect(r.links).toEqual([
          { url: "http://example.com/docs", secure: false },
        ]);
      });

      it("leaves nothing for a line that is only a label and a link", () => {
        const r = run(split(`Link: ${URL}`));
        expect(r.sentences).toEqual([]);
        expect(r.links).toEqual([{ url: URL, secure: true }]);
      });

      it("passes text without a link unchanged", () => {
        const text =
          "How much? It costs 5 credits a minute. Brackets [like this] stay.";
        const r = run(split(text));
        expect(r.sentences.join(" ")).toBe(text);
        expect(r.links).toEqual([]);
      });

      it("drops 'at' before a link that ends the sentence", () => {
        const r = run(split(`You can read more at ${URL}.`));
        expect(r.sentences).toEqual(["You can read more."]);
      });

      it("keeps two links in order", () => {
        const a = "https://app.voicethere.dev/docs/a";
        const b = "https://app.voicethere.dev/docs/b";
        const r = run(split(`First ${a} and second ${b}. Done.`));
        expect(r.sentences).toEqual(["First and second.", "Done."]);
        expect(r.links.map((l) => l.url)).toEqual([a, b]);
      });
    });
  }

  it("holds a URL split across three deltas", () => {
    const x = new LinkExtractor();
    expect(x.push("See htt")).toBe("See ");
    expect(x.push("ps://app.voicethere.dev/do")).toBe("");
    expect(x.push("cs/pricing now")).toBe(`${LINK_MARK} now`);
    expect(x.takeLink()).toEqual({
      url: "https://app.voicethere.dev/docs/pricing",
      secure: true,
    });
  });

  it("does not hold the 'h' at the end of a word", () => {
    const x = new LinkExtractor();
    expect(x.push("How much")).toBe("How much");
  });

  it("keeps balanced parentheses inside a URL", () => {
    const r = run(["Wiki (https://en.wikipedia.org/wiki/Foo_(bar)) here."]);
    expect(r.links.map((l) => l.url)).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("treats a bare scheme as text", () => {
    const r = run(["Type https:// first."]);
    expect(r.links).toEqual([]);
    expect(r.sentences).toEqual(["Type https:// first."]);
  });

  it("releases an unfinished markdown bracket at the end", () => {
    const r = run(["Options [a or b"]);
    expect(r.sentences).toEqual(["Options [a or b"]);
  });
});

describe("cleanLinkSentence", () => {
  it("returns a sentence without marks unchanged", () => {
    expect(cleanLinkSentence("Hello there.")).toBe("Hello there.");
  });

  it("turns a dangling colon into a full stop", () => {
    expect(
      cleanLinkSentence(
        `The full price list for every plan and pack is on this page: ${LINK_MARK}`,
      ),
    ).toBe("The full price list for every plan and pack is on this page.");
  });

  it("drops a label of up to three words before a link", () => {
    expect(cleanLinkSentence(`Pricing page: ${LINK_MARK}`)).toBe("");
    expect(cleanLinkSentence(`Done. Full price list: ${LINK_MARK}`)).toBe(
      "Done.",
    );
  });

  it("keeps a four-word lead-in and turns its colon into a full stop", () => {
    expect(cleanLinkSentence(`See the price list: ${LINK_MARK}`)).toBe(
      "See the price list.",
    );
  });

  it("removes empty parentheses left by a link", () => {
    expect(cleanLinkSentence(`Pricing (${LINK_MARK}) is simple.`)).toBe(
      "Pricing is simple.",
    );
  });
});

/** Raw extractor output (marks kept) and the links, without splitting or cleaning. */
function extract(deltas: string[]): { text: string; links: ExtractedLink[] } {
  const x = new LinkExtractor();
  let text = "";
  for (const d of deltas) text += x.push(d);
  text += x.end();
  return { text, links: x.takeAll() };
}

describe("LinkExtractor bare domains", () => {
  const splits = [
    ["one delta", (t: string) => [t]],
    ["char by char", chars],
    ["chunks of 3", (t: string) => chunks(t, 3)],
  ] as const;

  for (const [name, split] of splits) {
    describe(name, () => {
      it("turns app.voicethere.dev/docs/pricing into a link, keeps the host, drops the path", () => {
        const input = "See app.voicethere.dev/docs/pricing.";
        const r = run(split(input));
        expect(r.sentences).toEqual(["See app.voicethere.dev."]);
        expect(r.links).toEqual([
          {
            url: "https://app.voicethere.dev/docs/pricing",
            label: "app.voicethere.dev",
            secure: true,
            sourceText: "app.voicethere.dev/docs/pricing",
          },
        ]);
        const raw = extract(split(input));
        expect(raw.text).toBe(`See app.voicethere.dev${LINK_MARK}.`);
        expect(raw.text).not.toContain("/docs");
      });

      it("handles a host-only domain at the end of a sentence", () => {
        const r = run(split("Go to voicethere.dev."));
        expect(r.sentences).toEqual(["Go to voicethere.dev."]);
        expect(r.links).toEqual([
          {
            url: "https://voicethere.dev",
            label: "voicethere.dev",
            secure: true,
            sourceText: "voicethere.dev",
          },
        ]);
      });

      it("handles a host-only domain followed by a period and another sentence", () => {
        const r = run(split("Go to voicethere.dev. Then relax."));
        expect(r.sentences).toEqual(["Go to voicethere.dev.", "Then relax."]);
        expect(r.links.map((l) => l.url)).toEqual(["https://voicethere.dev"]);
      });

      it("handles a domain with a path at the end of a sentence followed by a period", () => {
        const r = run(split("Pricing is at voicethere.dev/pricing. Next."));
        expect(r.sentences).toEqual(["Pricing is at voicethere.dev.", "Next."]);
        expect(r.links.map((l) => l.url)).toEqual([
          "https://voicethere.dev/pricing",
        ]);
      });

      it("leaves a comma after the path in the text", () => {
        const r = run(
          split("See docs.voicethere.dev/docs/knowledge-rag, then ask."),
        );
        expect(r.sentences).toEqual(["See docs.voicethere.dev, then ask."]);
        expect(r.links.map((l) => l.url)).toEqual([
          "https://docs.voicethere.dev/docs/knowledge-rag",
        ]);
      });

      it("gives an unbalanced closing parenthesis back to the text", () => {
        const r = run(split("(voicethere.dev/pricing)"));
        expect(r.links.map((l) => l.url)).toEqual([
          "https://voicethere.dev/pricing",
        ]);
        const raw = extract(split("(voicethere.dev/pricing)"));
        expect(raw.text).toBe(`(voicethere.dev${LINK_MARK})`);
      });

      it("keeps the host as written", () => {
        const r = run(split("VoiceThere.DEV"));
        expect(r.links.map((l) => l.url)).toEqual(["https://VoiceThere.DEV"]);
      });

      it("a scheme URL is one link, not two", () => {
        const r = run(split("https://voicethere.dev/pricing"));
        expect(r.links).toEqual([
          { url: "https://voicethere.dev/pricing", secure: true },
        ]);
      });

      it("a markdown link is one link with its label", () => {
        const r = run(split("[Pricing](https://voicethere.dev/pricing)"));
        expect(r.links).toEqual([
          {
            url: "https://voicethere.dev/pricing",
            label: "Pricing",
            secure: true,
          },
        ]);
      });

      it("a domain inside a markdown label does not add a second link", () => {
        const r = run(split("[voicethere.dev](https://voicethere.dev/x)"));
        expect(r.links.map((l) => l.url)).toEqual(["https://voicethere.dev/x"]);
      });

      for (const text of [
        "Node.js",
        "next.config.ts",
        "package.json",
        "README.md",
        "run.sh",
        "e.g. this",
        "e.g., this",
        "i.e. that",
        "v1.2.3",
        "3.14",
        "U.S. users",
        "mail me at hi@voicethere.dev",
        "@voicethere/agent",
        "process.env.KEY",
        "foo.bar",
        "voicethere.devices",
        "my-file.com.backup",
        "voicethere.dev2",
        "x-voicethere.dev_y",
      ]) {
        it(`leaves ${JSON.stringify(text)} as text`, () => {
          const raw = extract(split(text));
          expect(raw.links).toEqual([]);
          expect(raw.text).toBe(text);
        });
      }
    });
  }

  it("holds a domain that is split across streamed chunks", () => {
    const x = new LinkExtractor();
    expect(x.push("Visit voicethere.d")).toBe("Visit ");
    expect(x.push("ev now.")).toBe(`voicethere.dev${LINK_MARK} `);
    expect(x.end()).toBe("now.");
    expect(x.takeLink()).toMatchObject({ url: "https://voicethere.dev" });
  });

  it("gives the same result when a domain with a path is split across chunks", () => {
    const whole = extract(["Open app.voicethere.dev/docs/llms-txt now."]);
    const split = extract(["Open app.voice", "there.dev/docs/llms-txt now."]);
    expect(split).toEqual(whole);
    expect(split.links.map((l) => l.url)).toEqual([
      "https://app.voicethere.dev/docs/llms-txt",
    ]);
  });

  it("decides a held domain on end()", () => {
    const x = new LinkExtractor();
    expect(x.push("Go to voicethere.dev")).toBe("Go to ");
    expect(x.end()).toBe(`voicethere.dev${LINK_MARK}`);
  });
});
