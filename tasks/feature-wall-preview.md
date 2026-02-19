# Feature: "See It On Your Wall" Room Preview

## The Idea

After the customer designs their tribute, they can upload a photo of the wall where it will hang. We composite the framed tribute onto the wall photo at realistic scale — so they can see exactly what it looks like in their home (or the recipient's home, for gift buyers).

## Why This Matters

- **Conversion driver**: Seeing the product in context makes it feel real, not hypothetical
- **Size confidence**: Customers hesitate on size (8x10 vs 12x16 vs 16x20) — this removes the guesswork
- **Gift buyers especially**: "I can see it hanging in her hallway" is the moment they commit
- **Reduces returns**: They know what they're getting

## How It Works — User Flow

### Step 1: "Want to see it on your wall?"
- Appears after the tribute is designed (poem generated, style chosen)
- Optional step — doesn't block checkout
- CTA: "See it in your home" or "Preview on your wall"

### Step 2: Upload a Wall Photo
- User takes a photo of the wall where the tribute will hang
- **Key instruction**: "Tape a regular piece of paper (8.5 x 11") to the wall before you take the photo"
- The paper is the scale reference — we know its real-world dimensions, so we can calculate pixels-per-inch for the photo

### Step 3: Mark the Reference Paper
- User clicks/taps the four corners of the paper in the photo
- Or: we attempt auto-detection (white rectangle on a wall — decent contrast case)
- From the 4 corners, we calculate:
  - **Scale**: pixels per inch (paper is 8.5" x 11")
  - **Perspective**: if the photo is at an angle, the paper corners give us the perspective transform

### Step 4: Position the Tribute
- The framed tribute composite appears overlaid on the wall photo
- User can drag to position it where they want
- Size is accurate to the selected product (8x10, 12x16, or 16x20 frame)
- Frame style matches their chosen variant (dark/warm/light)

### Step 5: See the Result
- Final composite showing the tribute on their wall
- "Switch size" buttons to instantly compare 8x10 vs 12x16 vs 16x20 in place
- Download/share button for the composite image

## Technical Approach

### Scale Detection from Reference Paper

```
Given: paper = 8.5" x 11"
User marks 4 corners in the photo → gives us pixel coordinates

Paper width in pixels = distance between top-left and top-right corners
Paper height in pixels = distance between top-left and bottom-left corners

Pixels per inch (horizontal) = paper_width_px / 8.5
Pixels per inch (vertical) = paper_height_px / 11

Average PPI = (h_ppi + v_ppi) / 2  (if photo is straight-on, these match)
```

If the corners form a trapezoid (angled photo), we need a perspective transform:
- Use the 4 corner positions to compute a homography matrix
- This maps from "real world" coordinates to "photo" coordinates
- Can use this to correctly distort the tribute overlay to match the wall's perspective

### Rendering the Composite

**Option A: Canvas-based (simpler, start here)**
- Load the wall photo onto a canvas
- Render the framed tribute (frame border + mat + tribute content) as a second layer
- Apply perspective transform if needed (CSS `transform: perspective()` or canvas matrix)
- User drags to position

**Option B: WebGL (if perspective accuracy matters)**
- More accurate perspective warping
- Overkill for v1

### Frame Rendering for the Overlay

We already have the CSS frame/mat rendering. For the wall composite, we need a rasterized version:
- Render the full framed tribute (frame + mat + photo panel + tribute panel) to an offscreen canvas
- Scale to the correct pixel size based on detected PPI and selected product dimensions
- Overlay onto the wall photo

### Product Dimensions (outer frame size, approximate)

| Product | Print Size | Frame adds ~2" | Outer Size |
|---------|-----------|-----------------|------------|
| Small   | 8x10"     | +2" each side   | ~10x12"    |
| Medium  | 12x16"    | +2" each side   | ~14x18"    |
| Large   | 16x20"    | +2" each side   | ~18x22"    |

These outer dimensions are what we render on the wall.

### Auto-Detection (Stretch Goal)

Instead of making the user click 4 corners, attempt automatic detection:
- Convert to grayscale
- Edge detection (Canny or Sobel — can use OpenCV.js)
- Find rectangles with ~8.5:11 aspect ratio
- Pick the most likely candidate (largest white rectangle)
- Fallback to manual if detection fails

This is a nice-to-have. Manual corner marking works fine for v1.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `public/js/wall-preview.js` | **New** | Wall photo upload, corner marking, scale calc, composite rendering |
| `public/css/wall-preview.css` | **New** | Overlay UI, corner markers, drag handles |
| `public/js/customizer.js` | **Modify** | Add "See it on your wall" button after poem section |
| `public/customize.html` | **Modify** | Add wall preview modal/section |

## UI Mockup

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │                                               │  │
│  │           [Wall photo fills here]             │  │
│  │                                               │  │
│  │              ┌──────────────┐                 │  │
│  │              │ ┌──────────┐ │                 │  │
│  │              │ │  Photo   │ │                 │  │
│  │              │ │          │ │  ← draggable    │  │
│  │              │ ├──────────┤ │    tribute       │  │
│  │              │ │  Poem    │ │    overlay       │  │
│  │              │ │          │ │                 │  │
│  │              │ └──────────┘ │                 │  │
│  │              └──────────────┘                 │  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  [ 8x10 ]  [ 12x16 ]  [ 16x20 ]    [Download]     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Edge Cases

- **No paper in photo**: Fallback to manual size estimation ("How wide is the wall area?") or just let them eyeball it with a slider
- **Paper partially hidden**: Need all 4 corners visible — show error with guidance
- **Very angled photo**: Perspective transform handles this, but extreme angles degrade quality
- **Dark walls**: Paper detection easier (white on dark). Light walls: harder auto-detection but manual marking still works
- **Mobile photos**: Usually high-res enough. EXIF orientation needs handling (already done in our upload pipeline with sharp)

## Dependencies

- No new npm packages required for v1 (canvas API handles it)
- OpenCV.js only if we pursue auto-detection (180KB gzipped — lazy load)

## Priority

Medium — this is a conversion optimization feature, not a launch blocker. Build after the core purchase flow (checkout, payment, order management) is working.
