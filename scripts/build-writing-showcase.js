/**
 * Build the "The Writing" showcase page — a self-contained HTML artifact that
 * presents the framed tributes large enough to read, scattered in varied
 * orientations with a four-up portrait grid, and sells the writing at each step.
 *
 * Embeds images + Cormorant Garamond as data URIs (artifact CSP blocks CDNs).
 * Usage: node scripts/build-writing-showcase.js
 * Output: output/site/writing-showcase.html
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const MOCK = path.join(ROOT, 'output', 'wall-mockups');
const FONTS = path.join(ROOT, 'src', 'assets', 'fonts');
const OUT = path.join(ROOT, 'output', 'site', 'writing-showcase.html');

const fontB64 = (f) => fs.readFileSync(path.join(FONTS, f)).toString('base64');
async function imgB64(name, box = 1180) {
  const buf = await sharp(path.join(MOCK, name))
    .resize(box, box, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

(async () => {
  const fCormorant500 = fontB64('CormorantGaramond-latin-500-normal.ttf');
  const fCormorant400i = fontB64('CormorantGaramond-latin-400-italic.ttf');
  const fCormorant300 = fontB64('CormorantGaramond-latin-300-normal.ttf');

  const img = {};
  for (const n of ['pixie-black', 'rusty-brown', 'biscuit-black', 'simba-black',
    'ziggy-black', 'domino-brown', 'tigger-black', 'mittens-brown', 'ghost-brown', 'callie-black']) {
    img[n] = await imgB64(n + '.jpg');
  }

  const html = `<style>
  @font-face{font-family:'Cormorant';src:url(data:font/ttf;base64,${fCormorant500}) format('truetype');font-weight:500;font-style:normal;font-display:swap}
  @font-face{font-family:'Cormorant';src:url(data:font/ttf;base64,${fCormorant300}) format('truetype');font-weight:300;font-style:normal;font-display:swap}
  @font-face{font-family:'Cormorant';src:url(data:font/ttf;base64,${fCormorant400i}) format('truetype');font-weight:400;font-style:italic;font-display:swap}

  :root{
    --bg:#ECE6DC; --bg-deep:#E3DCCF; --surface:#F6F2EA;
    --ink:#211B14; --ink-soft:#6E6353; --ink-faint:#9A8E7B;
    --gold:#A9884E; --gold-line:#C9B48A; --hair:#D6CCBA;
    --shadow:rgba(40,30,15,.20); --glow:rgba(255,253,248,.55);
    --sans:'Helvetica Neue',Arial,system-ui,sans-serif;
    --serif:'Cormorant',Georgia,serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#15110C; --bg-deep:#0F0C08; --surface:#1E1810;
    --ink:#F0E9DC; --ink-soft:#B0A48E; --ink-faint:#7C7160;
    --gold:#CBA968; --gold-line:#7A6238; --hair:#2C251B;
    --shadow:rgba(0,0,0,.5); --glow:rgba(96,73,45,.38);
  }}
  :root[data-theme="light"]{
    --bg:#ECE6DC; --bg-deep:#E3DCCF; --surface:#F6F2EA;
    --ink:#211B14; --ink-soft:#6E6353; --ink-faint:#9A8E7B;
    --gold:#A9884E; --gold-line:#C9B48A; --hair:#D6CCBA; --shadow:rgba(40,30,15,.20); --glow:rgba(255,253,248,.55);
  }
  :root[data-theme="dark"]{
    --bg:#15110C; --bg-deep:#0F0C08; --surface:#1E1810;
    --ink:#F0E9DC; --ink-soft:#B0A48E; --ink-faint:#7C7160;
    --gold:#CBA968; --gold-line:#7A6238; --hair:#2C251B; --shadow:rgba(0,0,0,.5); --glow:rgba(96,73,45,.38);
  }

  *{box-sizing:border-box}
  /* Seamless ground: flat base + a soft top glow that fades fully to transparent
     (no hard edge), plus a faint fixed noise layer that dithers away the banding
     that plagues gradients over the near-black espresso in dark mode. */
  .sbm-wrap{background:var(--bg);color:var(--ink);font-family:var(--sans);
    -webkit-font-smoothing:antialiased;line-height:1.6;overflow-x:clip;position:relative;z-index:0}
  .sbm-wrap::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background:radial-gradient(140% 78% at 50% -22%, var(--glow) 0%, rgba(0,0,0,0) 62%)}
  .sbm-wrap::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.045;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)'/%3E%3C/svg%3E");background-size:150px 150px}
  .sbm-wrap>*{position:relative;z-index:1}
  .sbm-wrap ::selection{background:var(--gold);color:var(--bg)}
  .col{max-width:1120px;margin:0 auto;padding:0 24px}
  .narrow{max-width:640px}

  /* type */
  .eyebrow{font-family:var(--sans);font-size:.72rem;font-weight:600;letter-spacing:.22em;
    text-transform:uppercase;color:var(--gold);margin:0}
  h1.display{font-family:var(--serif);font-weight:500;line-height:1.02;letter-spacing:-.01em;
    font-size:clamp(2.7rem,7vw,5.3rem);margin:.35em 0 0;text-wrap:balance;color:var(--ink)}
  h2.head{font-family:var(--serif);font-weight:500;line-height:1.06;letter-spacing:-.01em;
    font-size:clamp(2rem,4.6vw,3.3rem);margin:0 0 .5em;text-wrap:balance}
  .lede{font-size:1.16rem;color:var(--ink-soft);max-width:60ch;text-wrap:pretty}
  .kicker{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--gold);
    font-size:1.5rem;line-height:1.3}
  p{text-wrap:pretty}

  /* rhythm */
  section{padding:clamp(72px,11vw,150px) 0}
  .rule{width:54px;height:1px;background:var(--gold-line);border:0;margin:0 0 30px}

  /* hero */
  .hero{padding-top:clamp(70px,10vw,120px);padding-bottom:clamp(40px,6vw,70px)}
  .hero .lede{margin-top:26px}

  /* framed pieces */
  figure.piece{margin:0;filter:drop-shadow(0 24px 44px var(--shadow))}
  figure.piece img{display:block;width:100%;height:auto;border-radius:3px}
  figure.piece figcaption{margin-top:18px;font-size:.9rem;color:var(--ink-faint);
    font-family:var(--sans);letter-spacing:.01em;max-width:44ch}
  figure.piece figcaption b{color:var(--ink-soft);font-weight:600}
  .tl{transform:rotate(-1.4deg)} .tr{transform:rotate(1.3deg)}
  @media (prefers-reduced-motion:reduce){.tl,.tr{transform:none}}

  .showcase{max-width:1180px;margin:0 auto;padding:0 24px;display:flex;flex-direction:column;gap:clamp(80px,12vw,150px)}
  .stage{display:grid;grid-template-columns:1fr;gap:clamp(28px,4vw,56px);align-items:center}
  .stage.split{grid-template-columns:1fr 1fr}
  .stage.split.rev .txt{order:2}
  .stage .big{max-width:760px;width:100%;justify-self:center}
  @media (max-width:760px){.stage.split{grid-template-columns:1fr}.stage.split.rev .txt{order:0}}

  /* pull quotes — the lines left behind */
  .quotes{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;border-top:1px solid var(--hair)}
  .pq{padding:30px 0;border-bottom:1px solid var(--hair);display:grid;
    grid-template-columns:1fr auto;gap:14px 28px;align-items:baseline}
  .pq q{font-family:var(--serif);font-weight:500;font-size:clamp(1.5rem,3.4vw,2.35rem);
    line-height:1.22;quotes:"\\201C" "\\201D";color:var(--ink);text-wrap:balance}
  .pq .who{font-family:var(--sans);font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;
    color:var(--gold);white-space:nowrap;padding-top:.4em}

  /* humor cards */
  .humor{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:8px}
  @media (max-width:720px){.humor{grid-template-columns:1fr}}
  .hcard{background:var(--surface);border:1px solid var(--hair);border-radius:6px;
    padding:30px 26px;display:flex;flex-direction:column;gap:16px}
  .hcard .line{font-family:var(--serif);font-weight:500;font-size:1.6rem;line-height:1.28;color:var(--ink)}
  .hcard .who{font-family:var(--sans);font-size:.74rem;letter-spacing:.16em;text-transform:uppercase;color:var(--gold)}

  /* four-up portrait grid */
  .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:clamp(16px,2.4vw,30px)}
  @media (max-width:900px){.grid4{grid-template-columns:repeat(2,1fr);gap:20px}}
  .grid4 figure{filter:drop-shadow(0 18px 34px var(--shadow))}

  /* testimonials */
  .voices{display:grid;grid-template-columns:1fr 1fr;gap:clamp(20px,3vw,36px)}
  @media (max-width:760px){.voices{grid-template-columns:1fr}}
  .vcard{background:var(--surface);border:1px solid var(--hair);border-radius:8px;
    padding:clamp(28px,3.4vw,42px);margin:0;display:flex;flex-direction:column;gap:24px}
  .vcard blockquote{margin:0;font-family:var(--serif);font-weight:500;
    font-size:clamp(1.32rem,2.3vw,1.62rem);line-height:1.42;color:var(--ink);text-wrap:pretty}
  .vcard .attrib{display:flex;align-items:center;gap:16px;margin-top:auto;padding-top:8px;border-top:1px solid var(--hair)}
  .vcard .attrib img{width:74px;height:90px;object-fit:cover;object-position:top;border-radius:3px;
    box-shadow:0 6px 16px var(--shadow);flex:none;margin-top:14px}
  .vcard .attrib .nm{font-family:var(--sans);font-weight:600;color:var(--ink);font-size:.95rem}
  .vcard .attrib .pet{font-family:var(--sans);font-size:.74rem;letter-spacing:.14em;
    text-transform:uppercase;color:var(--gold);margin-top:4px}

  /* closing */
  .close{text-align:center}
  .close h2.head{margin-inline:auto}
  .close .lede{margin:0 auto}
  .sig{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--gold);font-size:1.35rem;margin-top:34px}

  footer.foot{border-top:1px solid var(--hair);padding:40px 0 60px;color:var(--ink-faint);font-size:.82rem}

  /* reveal — pure CSS so content is NEVER left hidden if JS/observers don't run
     (the artifact sandbox doesn't always fire IntersectionObserver). fill:both
     guarantees every element ends fully visible. */
  .rise{animation:riseIn .85s cubic-bezier(.2,.7,.2,1) both}
  @keyframes riseIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.rise{animation:none}}
</style>

<div class="sbm-wrap">

  <header class="hero">
    <div class="col">
      <p class="eyebrow">Still Beside Me &middot; The Writing</p>
      <h1 class="display">We don't write about grief.<br>We write the pet back into the room.</h1>
      <p class="lede">Every tribute is a photograph and a poem. The photograph shows you the animal. The poem does something harder &mdash; it recreates the small, exact, domestic details that made them unmistakably <em>themselves</em>. Read one below, the way it hangs on the wall.</p>
    </div>
  </header>

  <div class="showcase">

    <figure class="piece tl rise" style="max-width:560px;margin-inline:auto">
      <img src="${img['pixie-black']}" alt="Framed tribute for Pixie: a tabby-and-white cat above a poem on cream paper">
      <figcaption style="margin-inline:auto;text-align:center"><b>Pixie.</b> Not &ldquo;a gentle soul, deeply missed.&rdquo; A specific blue chair, a ten-o'clock ritual, and the thing that's still there when she isn't.</figcaption>
    </figure>

    <section class="stage split rev" style="padding:0">
      <figure class="piece tr rise">
        <img src="${img['rusty-brown']}" alt="Framed tribute for Rusty, an Australian shepherd, beside his poem">
      </figure>
      <div class="txt narrow rise">
        <hr class="rule">
        <h2 class="head">Recognizable, not interchangeable.</h2>
        <p class="lede">Most memorial writing describes grief in general terms &mdash; the loyal friend, the hole in the heart, the bridge. Ours does the opposite. It reaches for the one flat grey tennis ball, the truck heard three streets away, the exact spot by the door. A stranger could pick your dog out of a crowd from the poem alone.</p>
      </div>
    </section>

    <section style="padding:0">
      <div class="col narrow rise" style="margin-bottom:40px">
        <hr class="rule">
        <h2 class="head">The line that undoes you is the one still in the room.</h2>
        <p class="lede">The hardest lines aren't about dying. They're about the ordinary thing left behind &mdash; still sitting there, still waiting, as if nothing had changed.</p>
      </div>
      <div class="col">
        <div class="quotes rise">
          <div class="pq"><q>The blue chair is still yours. We just sit beside it now.</q><span class="who">Pixie</span></div>
          <div class="pq"><q>The ball's still on the porch. We couldn't bring ourselves to move it.</q><span class="who">Rusty</span></div>
          <div class="pq"><q>I still wake at six. I still reach across the pillow.</q><span class="who">Marbles</span></div>
          <div class="pq"><q>The house is bigger without you.</q><span class="who">Callie</span></div>
          <div class="pq"><q>Slow down now, sweet one. We will catch up to you.</q><span class="who">Biscuit</span></div>
        </div>
      </div>
    </section>

    <section class="stage split" style="padding:0">
      <div class="txt narrow rise">
        <hr class="rule">
        <h2 class="head">First, it makes you smile.</h2>
        <p class="lede">Before the turn, there is almost always a small joke &mdash; the pet caught being exactly, ridiculously themselves. That's what makes them feel alive on the page, so the ache that follows lands on someone real instead of a symbol.</p>
      </div>
      <figure class="piece tl big rise">
        <img src="${img['domino-brown']}" alt="Framed tribute for Marbles, a tabby cat, beside his poem">
        <figcaption><b>Marbles.</b> &ldquo;Head on the pillow like you paid the mortgage.&rdquo; You laugh &mdash; and then the last line reaches the six o'clock alarm you still can't turn off.</figcaption>
      </figure>
    </section>

    <div class="col">
      <div class="humor rise">
        <div class="hcard"><span class="line">&ldquo;Head on the pillow like you paid the mortgage.&rdquo;</span><span class="who">Marbles</span></div>
        <div class="hcard"><span class="line">&ldquo;&hellip;and found it, on the whole, acceptable.&rdquo;</span><span class="who">Tigger</span></div>
        <div class="hcard"><span class="line">&ldquo;Turned up at the door at six on the dot. Dinner, right on time.&rdquo;</span><span class="who">Ziggy</span></div>
      </div>
    </div>

    <section style="padding:0">
      <div class="col narrow rise" style="margin-bottom:44px">
        <hr class="rule">
        <h2 class="head">Four at once. No two could be swapped.</h2>
        <p class="lede">Each tribute is written from scratch for one animal &mdash; its own habits, its own room, its own small joke. Hang four on a wall and the writing never repeats itself.</p>
      </div>
      <div class="col">
        <div class="grid4 rise">
          <figure class="piece"><img src="${img['tigger-black']}" alt="Framed tribute for Tigger, a tabby cat"></figure>
          <figure class="piece"><img src="${img['mittens-brown']}" alt="Framed tribute for Mittens, a white cat"></figure>
          <figure class="piece"><img src="${img['ghost-brown']}" alt="Framed tribute for Ghost, a white cat"></figure>
          <figure class="piece"><img src="${img['callie-black']}" alt="Framed tribute for Callie, a dog"></figure>
        </div>
      </div>
    </section>

    <section style="padding:0">
      <div class="col narrow rise" style="margin-bottom:40px">
        <hr class="rule">
        <h2 class="head">From the families.</h2>
        <p class="lede">Two of the tributes above went home to real families. Here is what they wrote back.</p>
      </div>
      <div class="col">
        <div class="voices rise">
          <figure class="vcard">
            <blockquote>&ldquo;A soft gold comma at the end of our days&rdquo; is one of the most beautiful descriptions of him I could imagine. Mittens spent his life finding the warmest patch of sunlight and reminding us to slow down. The poem didn't only memorialize him &mdash; it made his way of living feel like something worth carrying forward.</blockquote>
            <div class="attrib">
              <img src="${img['mittens-brown']}" alt="Mittens' framed tribute">
              <span><span class="nm">Rob &amp; Kathy</span><span class="pet">On Mittens' tribute</span></span>
            </div>
          </figure>
          <figure class="vcard">
            <blockquote>The line about the house feeling bigger and quieter was exactly right. Callie had been beside our children for nearly their entire childhood &mdash; woven into every ordinary family moment. The memorial made us realize we weren't only grieving her, but the end of an entire chapter of our family's life.</blockquote>
            <div class="attrib">
              <img src="${img['callie-black']}" alt="Callie's framed tribute">
              <span><span class="nm">Danielle T.</span><span class="pet">On Callie's tribute</span></span>
            </div>
          </figure>
        </div>
      </div>
    </section>

    <section class="stage split rev" style="padding:0">
      <figure class="piece tr big rise">
        <img src="${img['biscuit-black']}" alt="Framed tribute for Biscuit, a golden retriever puppy">
      </figure>
      <div class="txt narrow rise">
        <hr class="rule">
        <p class="kicker">&ldquo;Slow down now, sweet one. We will catch up to you.&rdquo;</p>
        <p class="lede" style="margin-top:22px">A photograph freezes a moment. A tribute like this gives the whole animal back &mdash; the mischief, the routine, the particular way the house feels without them.</p>
      </div>
    </section>

  </div>

  <section class="close">
    <div class="col narrow">
      <hr class="rule" style="margin-inline:auto">
      <h2 class="head">That balance is the product.</h2>
      <p class="lede">The specific detail. The small joke. The thing left on the porch. Together they are what separate this from sentimental, interchangeable memorial poetry &mdash; and they are why it stays on the wall instead of in a drawer.</p>
      <p class="sig">Their story is kept. Their room stays theirs.</p>
    </div>
  </section>

  <footer class="foot">
    <div class="col">Still Beside Me &mdash; a photograph and a poem, framed for the wall. Sample tributes shown; every poem is written new for one animal.</div>
  </footer>

</div>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`Wrote ${OUT} (${kb}KB)`);
})().catch((e) => { console.error(e); process.exit(1); });
