# Lessons Learned

## Typography Rules
- **NEVER use em dashes (`—` / `\u2014`) anywhere.** Not in copy, not in code comments, not in titles, nowhere. Use en dashes (`–` / `\u2013`) for date ranges, attributions, and parenthetical breaks. The owner has explicitly banned em dashes across the entire project.

## Poem Content Rules
- NEVER generate poems that mention death, dying, the devil, hell, darkness, morbid imagery, or anything unsettling.
- Poems must be warm, hopeful, and life-affirming. Focus on what the pet brought to the family, not on the absence.
- No clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them.
- These rules apply to both AI-generated poems and the fallback template stub.

## Canvas Rendering
- When rendering text on canvas, try all spacing compression tiers BEFORE shrinking font size. Poem font only shrinks as a last resort (floor 82%). Never cut off text with a hard `break`.
- Blank lines in poems should render at 50% line height, not full height. They're breathing room, not wasted space.
- Use en dash (`\u2013`) for date ranges on tribute panels, curly quotes (`\u201C`/`\u201D`) for nicknames.

## Product Context
- PRIMARY buyer is sympathy gifter, SECONDARY is pet owner memorializing their own pet.
- Form questions must accommodate gift buyers who may not know personal details. Sublabels should explicitly say "skip this" for optional emotional fields in gift mode.

## Landing Page Framework (Oliver Kenyon CRO)
Every landing page should follow this structure in order:

1. **ATTENTION (Hero)** – Hook them immediately. Headline + subhead + hero visual + CTA. Answer "what is this and why should I care?"
2. **TRANSFORMATION** – Visual journey from NOT owning the product → owning and benefiting from it. Use icons, steps, and text to walk the buyer through: add to cart → receive → benefit. Show the before/after state.
3. **INTEREST Part 1: BENEFITS** – Exact outcomes the target buyer gets. Think time, money, freedom, emotion, lifestyle. Benefits sell. Lead with what the product DOES for them, not what it IS.
4. **INTEREST Part 2: FEATURES** – Only after they've visualized the outcome, show HOW you deliver it. Images, icons, text, video showing the bells and whistles. Features tell.
5. **DESIRE (Social Proof)** – Make them want it using other people. Reviews, testimonials, case studies, UGC. This is where FOMO lives.
6. **COMPARE** – Two options: (a) pitch against competitors, or (b) pitch against generalizations (broader market trends, general consumer expectations). Use comparison tables/cards.
7. **OBJECTIONS (FAQ)** – If they've scrolled this far they're interested but have questions. Use simple FAQ to address ordering, returns, outcomes, and "what if" concerns.
8. **FINAL CTA** – Close the sale with urgency and confidence.
