import { describe, it, expect } from "vitest";
import { titleCase, detectLang } from "./titleCase";

describe("detectLang", () => {
  it("defaults to English with no signal", () => {
    expect(detectLang("Ziggy Stardust")).toBe("en");
    expect(detectLang("")).toBe("en");
  });
  it("detects English from function words", () => {
    expect(detectLang("the dark side of the moon")).toBe("en");
  });
  it("detects German from ß and function words", () => {
    expect(detectLang("strasse der begierde")).toBe("de");
    expect(detectLang("weiße rosen im schnee")).toBe("de");
  });
  it("detects French from diacritics and elisions", () => {
    expect(detectLang("les feuilles mortes de l'automne")).toBe("fr");
    expect(detectLang("concerto pour la main gauche")).toBe("fr");
  });
});

describe("titleCase — English", () => {
  it("capitalizes principal words, lowercases small words", () => {
    expect(titleCase("the dark side of the moon")).toBe("The Dark Side of the Moon");
  });
  it("always capitalizes the first and last word", () => {
    expect(titleCase("a night at the opera")).toBe("A Night at the Opera");
    expect(titleCase("what is it all for")).toBe("What Is It All For");
  });
  it("fixes ALL-CAPS input", () => {
    expect(titleCase("NOTHING ELSE MATTERS")).toBe("Nothing Else Matters");
  });
  it("capitalizes inside leading punctuation", () => {
    expect(titleCase("the wall (remastered)")).toBe("The Wall (Remastered)");
  });
  it("preserves whitespace", () => {
    expect(titleCase("a  love   supreme")).toBe("A  Love   Supreme");
  });
});

describe("titleCase — German", () => {
  it("lowercases function words mid-title, capitalizes the rest", () => {
    expect(titleCase("die reise ins innere der stille")).toBe("Die Reise Ins Innere der Stille");
  });
  it("capitalizes first and last even when they are function words", () => {
    expect(titleCase("der himmel über berlin")).toBe("Der Himmel über Berlin");
  });
});

describe("titleCase — French", () => {
  it("uses sentence case — only the first word capitalized", () => {
    expect(titleCase("les feuilles mortes de l'automne")).toBe("Les feuilles mortes de l'automne");
  });
  it("preserves existing interior capitals (proper nouns)", () => {
    expect(titleCase("un été à Paris avec Édith")).toBe("Un été à Paris avec Édith");
  });
  it("lowercases an ALL-CAPS French title but keeps the first capital", () => {
    expect(titleCase("LA VIE EN ROSE")).toBe("La vie en rose");
  });
});

describe("titleCase — edge cases", () => {
  it("returns blank/whitespace input unchanged", () => {
    expect(titleCase("")).toBe("");
    expect(titleCase("   ")).toBe("   ");
  });
});
