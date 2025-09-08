// ============================================================================
// constants.js
// ----------------------------------------------------------------------------
// Shared configuration for server and client. Server imports this file directly,
// and also exposes its JSON form at GET /config so the client can fetch it.
// ============================================================================

// constants.js

// Check the environment. Default to 'development' if NODE_ENV is not set.
const isProduction = process.env.NODE_ENV === 'production';

const ROUND_DURATION_SECONDS_PROD = 60;
const BOT_INTERVAL_MINUTES_PROD = 1;
const HISTORY_CHUNK_SCHEDULE_CRON_PROD = '0 6,12,18,0 * * *';

const ROUND_DURATION_SECONDS_DEV = 30;
const BOT_INTERVAL_MINUTES_DEV = 0.5;
const HISTORY_CHUNK_SCHEDULE_CRON_DEV = '*/20 * * * *';

module.exports = {
  // --- Round / sentence ---
  ROUND_DURATION_SECONDS: isProduction ? ROUND_DURATION_SECONDS_PROD : ROUND_DURATION_SECONDS_DEV,
  CURRENT_TEXT_LENGTH: 100,

  // --- Client UX ---
  INPUT_MAX_CHARS: 25,
  ANONYMOUS_MAX_SUB_PER_HOUR: 10,

  // --- Bot / seeding ---
  ANONYMOUS_NAME: "Anonymous",
  BOT_NAME: "SNTNZ_BOT",
  BOT_LOOKBACK_MULTIPLIER: 1,
  BOT_SENTENCE_MIN_WORDS: 15,
  BOT_SENTENCE_MAX_WORDS: 50,
  BOT_INTERVAL_MINUTES: isProduction ? BOT_INTERVAL_MINUTES_PROD : BOT_INTERVAL_MINUTES_DEV,
  AI_TIMEOUT_MS: 25000,

  BOT_STOP_WORDS:['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'of', 'by', 'is', 'am', 'are', 'was', 'were', 'his', 'her', 'its', 'like'],

  // --- MODELS ---
  IMAGEN_MODEL:'imagen-3.0-generate-001',
  GEMINI_MODEL:'gemini-2.5-flash-lite',

  // --- Social Media ---
  FB_GRAPH_VERSION: 'v23.0',
  FB_USER_TOKEN_REFRESH_SCHEDULE_CRON: '30 3 * * *',
  SOCIAL_HASHTAGS: '#AIart #GenerativeArt #AutonomousArt #CollaborativeWriting #DigitalLiterature #Automation #AIGenerated #AI #TextToImage #ArtMachine #AIBot #EndlessStory #CollectiveCreativity #CreativeCoding #WritingCommunity #Web3 #DigitalOwnership #NFTart #AIartist #sntnz',
  SOCIAL_X_HASHTAGS: '#AIart #GenerativeArt #AutonomousArt #CollaborativeWriting #DigitalLiterature #TextToImage #CreativeCoding #WritingCommunity #NFTart #sntnz',

  // --- Validation ---
  PUNCTUATION_REGEX_STRING: "^[(\"'*_]*[a-zA-Z0-9'-]+[.,!?;:...\"'_)]*$",

  // --- History ---
  HISTORY_CHUNK_SCHEDULE_CRON: isProduction ? HISTORY_CHUNK_SCHEDULE_CRON_PROD : HISTORY_CHUNK_SCHEDULE_CRON_DEV,

  // --- Image styles ---
  IMAGE_STYLES: [
    {
      name: "Mesoamerican Codex",
      description: "Pre-Columbian manuscript aesthetics with modular glyphs, bold contouring, geometric order, and dense ornamental banding.",
      enforce: [
        "natural pigments", "cochineal red", "indigo", "bold contour lines",
        "flat color fields", "modular glyphs", "ornamental banding", "screenfold layout"
      ],
      forbid: [
        "photographic shading", "3D rendering", "neon glow", "lens flare",
        "airbrush gradients", "realistic volumetric lighting", "oil impasto", "chrome"
      ],
      palette: ["earth pigments", "cochineal red", "indigo blue", "ochre", "black outline"],
      surface: ["amateur amate bark paper look", "painted codex plate", "matte finish"]
    },
    {
      name: "Egyptian Papyrus Fresco",
      description: "New Kingdom style with composite perspective, linear clarity, and strict canon proportions.",
      enforce: [
        "papyrus texture", "matte mineral pigments", "black outline",
        "composite perspective", "frontal torsos with profile heads", "register lines"
      ],
      forbid: [
        "realistic perspective", "depth of field", "digital glow", "chrome",
        "airbrush shading", "photoreal skin", "lens blur"
      ],
      palette: ["malachite green", "red ochre", "carbon black", "gypsum white", "earth tones"],
      surface: ["papyrus fibers", "dry matte paint", "crisp linework"]
    },
    {
      name: "Mughal Miniature Painting",
      description: "Courtly manuscript style with minute ornament, delicate isometry, jeweled palettes, and fine detailing.",
      enforce: [
        "opaque watercolor (gouache)", "gold heightening", "fine brushwork",
        "miniature scale detailing", "isometric gardens and pavilions", "ornate borders"
      ],
      forbid: [
        "neon glow", "HDR shine", "vector-clean edges", "spray paint look",
        "sci-fi UI", "chrome", "photographic bokeh"
      ],
      palette: ["jewel tones", "vermilion", "lapis blue", "malachite green", "gold"],
      surface: ["smooth burnished paper", "illumination sparkle", "album page border"]
    },
    {
      name: "Japanese Ukiyo-e & Rimpa School",
      description: "Graphic linework, flattened planes, rhythmic compositions with decorative gold-ground patterns.",
      enforce: [
        "woodblock print registration", "keyblock outlines", "flat color areas",
        "mica or gold ground (Rimpa)", "asymmetrical composition", "kento marks"
      ],
      forbid: [
        "oil impasto", "photographic gradients", "lens flare", "3D shading",
        "chrome surfaces", "HDR glow", "digital noise"
      ],
      palette: ["indigo", "vermilion", "sumi ink", "gold leaf", "muted dyes"],
      surface: ["washi paper texture", "woodblock grain hints", "crisp registration"]
    },
    {
      name: "Dutch Golden Age Chiaroscuro",
      description: "Oil-on-canvas style with dramatic chiaroscuro, controlled value structure, subtle glazing.",
      enforce: [
        "oil on canvas", "layered glazing", "deep chiaroscuro", "warm underpainting",
        "varnished surface", "soft edge transitions", "visible brushwork"
      ],
      forbid: [
        "neon", "bioluminescent glow", "sci-fi UI", "chrome highlights", "HDR",
        "vector-clean edges", "flat graphic poster look"
      ],
      palette: ["earth pigments", "raw umber", "burnt sienna", "lead white", "lamp black"],
      surface: ["canvas weave", "varnish bloom", "subtle craquelure"]
    },
    {
      name: "Dynamic Art Nouveau",
      description: "Ornamental linework, flowing arabesques, organic asymmetry, luxurious decorative surfaces.",
      enforce: [
        "lithographic poster feel", "flowing arabesques", "whiplash curves",
        "ornamental frames", "flat decorative fields", "stylized flora"
      ],
      forbid: [
        "hard pixel edges", "industrial sci-fi UI", "chrome mechs", "photoreal",
        "gamey specular highlights", "neon cyber glow"
      ],
      palette: ["soft pastels", "muted jewel tones", "cream grounds", "gold accents"],
      surface: ["smooth litho texture", "poster grain", "clean margins"]
    },
    {
      name: "Streamlined Art Deco",
      description: "Geometric streamlining, sharp symmetry, metallic polish, high-contrast opulence.",
      enforce: [
        "symmetrical layout", "sunburst motifs", "stepped forms", "lacquer sheen",
        "stylized geometry", "architectural ornament"
      ],
      forbid: [
        "messy grunge", "handmade brush chaos", "impressionist dabbling",
        "low-contrast haze", "washed watercolor bleed"
      ],
      palette: ["black", "ivory", "gold", "teal", "crimson accents"],
      surface: ["lacquer-like panel", "polished metallic cues", "sharp edges"]
    },
    {
      name: "Generative Glitch Art",
      description: "Algorithmic distortion, databending, signal decomposition, precise digital artifacting.",
      enforce: [
        "scanline artifacts", "datamosh blocks", "RGB channel splits",
        "compression blocks", "spectral waveforms", "feedback trails"
      ],
      forbid: [
        "classical oil brushwork", "paper fiber grain", "antique varnish",
        "hand-ink line jitter", "woodblock registration"
      ],
      palette: ["additive RGB", "CMYK clash", "monochrome noise maps"],
      surface: ["clean archival print margins", "digital pixel structure"]
    },
    {
      name: "Anachronic Steampunk Mechanics",
      description: "Victorian techno-romance with patent plate aesthetics, intricate crosshatching, engraved blueprint style.",
      enforce: [
        "copperplate engraving lines", "crosshatching", "exploded diagrams",
        "Victorian typography", "patent labels", "machined brass and leather cues"
      ],
      forbid: [
        "neon cyber glow", "slick chrome futurism", "digital gradients",
        "soft painterly sfumato", "photographic depth of field"
      ],
      palette: ["sepia", "ink black", "oxidized brass", "parchment tone"],
      surface: ["engraving plate feel", "paper grain", "ink impression"]
    },
    {
      name: "Mid-Century Graphic Optimism",
      description: "Modernist order with playful geometry, disciplined grids, cheerful colors, bold simplicity.",
      enforce: [
        "silkscreen look", "flat shapes", "geometric forms", "clean grids",
        "simple iconography", "bold figure-ground"
      ],
      forbid: [
        "hyper detail", "oil impasto", "photographic realism", "grunge textures",
        "complex gradients"
      ],
      palette: ["cheerful primaries", "pastels", "off-black ink"],
      surface: ["silkscreen paper", "slight print misregistration"]
    },
    {
      name: "Psychedelic 70s Funk",
      description: "Concert-poster style with swirling forms, saturated inks, vibrating colors, surreal comix energy.",
      enforce: [
        "hand-lettered poster vibes", "swirling contours", "overprint effects",
        "vibrating complementary colors", "trippy motifs"
      ],
      forbid: [
        "classical chiaroscuro", "muted earth-only palette", "photographic bokeh",
        "sterile vector minimalism"
      ],
      palette: ["acid brights", "fluorescents", "ink overprints"],
      surface: ["poster paper", "screenprint grain"]
    },
    {
      name: "80s Neon & Memphis Design",
      description: "Bold postmodern style with flat neons, playful geometric forms, exaggerated contrast, early digital cues.",
      enforce: [
        "flat neon planes", "Memphis patterns", "geometric icons",
        "drop shadows", "grid backdrops", "retro vapor motifs"
      ],
      forbid: [
        "oil canvas weave", "antique paper grain", "Renaissance sfumato",
        "baroque glazing", "hand-engraved hatching"
      ],
      palette: ["electric cyan", "magenta", "yellow", "black", "pastel neons"],
      surface: ["magazine cover slickness", "clean vector edges"]
    },
    {
      name: "90s Grunge & Analog Glitch",
      description: "Layered distressed textures, photocopy wear, experimental type, analog-digital hybrid.",
      enforce: [
        "xerox noise", "tape scuffs", "overprint misalign", "hand-cut collage edges",
        "bitmap halftone", "staple shadows"
      ],
      forbid: [
        "polished chrome", "perfect vector edges", "museum varnish gloss",
        "classical oil blending"
      ],
      palette: ["dirty blacks", "burnt reds", "acid greens", "desaturated inks"],
      surface: ["zine paper", "distressed layers", "fold creases"]
    },
    {
      name: "80s Cyberpunk Anime Opus",
      description: "High-density technical linework, cinematic framing, futuristic architecture, precise mechanical design.",
      enforce: [
        "cell-shaded anime", "technical lineart", "retro-futuristic cityscapes",
        "ventilation grilles and ducts", "film grain", "theatrical key art"
      ],
      forbid: [
        "oil impasto", "antique paper fibers", "woodblock registration",
        "baroque glazing", "ink wash bleeding"
      ],
      palette: ["neon accents", "noctilucent blues", "industrial grays"],
      surface: ["poster finish", "clean cel lines"]
    },
    {
      name: "Kubrickian One-Point Perspective",
      description: "Measured one-point perspective, axial symmetry, immaculate alignment, austere spatial geometry.",
      enforce: [
        "perfect one-point perspective", "central vanishing point",
        "axial symmetry", "precise framing", "geometric interiors"
      ],
      forbid: [
        "tilted camera chaos", "fish-eye distortion", "handheld jitter",
        "painterly randomness", "baroque diagonals"
      ],
      palette: ["neutral interiors", "controlled saturation", "clean whites"],
      surface: ["cinematic poster", "crisp edges"]
    },
    {
      name: "Lynchian Industrial Surrealism",
      description: "Industrial textures, eerie atmospherics, surreal staging, moody monochrome depth.",
      enforce: [
        "monochrome or muted tones", "industrial grain", "film-like noise",
        "foggy atmospherics", "uncanny staging"
      ],
      forbid: [
        "bright neon palette", "comic-book flatness", "cheerful poster vibes",
        "classical varnish sheen"
      ],
      palette: ["soot blacks", "smoky grays", "rust browns"],
      surface: ["photogravure feel", "velvety blacks"]
    },
    {
      name: "Abstract Expressionist Gestures",
      description: "Large-scale expressive gestures, layered paint depth, assertive marks, material immediacy.",
      enforce: [
        "canvas-scale gestures", "drips and splatters", "impasto ridges",
        "layered paint", "energetic brush marks"
      ],
      forbid: [
        "precise lineart", "vector cleanliness", "technical drafting",
        "miniature filigree", "neon UI"
      ],
      palette: ["bold primaries", "earth blacks", "stained canvas tones"],
      surface: ["raw canvas edges", "thick paint texture"]
    },
    {
      name: "Bauhaus Functionalist Design",
      description: "Geometric clarity, strict grids, functionalist order, experimental typography.",
      enforce: [
        "modular grids", "geometric primitives", "sans-serif type experiments",
        "asymmetric balance", "functional iconography"
      ],
      forbid: [
        "baroque ornament", "organic arabesques", "random grunge",
        "oil glazing textures", "hand-ink jitter"
      ],
      palette: ["black", "white", "primary red", "primary blue", "primary yellow"],
      surface: ["poster board", "clean print edges"]
    },
    {
      name: "Expressive Black & White Minimalism",
      description: "Monochrome reduction with bold contrasts, sharp lines, minimal forms.",
      enforce: [
        "high-contrast black and white", "bold shapes", "sharp delineation",
        "negative space discipline", "ink-like marks"
      ],
      forbid: [
        "color gradients", "neon", "busy textures", "photographic color",
        "ornamental excess"
      ],
      palette: ["pure black", "paper white"],
      surface: ["screenprint feel", "smooth poster finish"]
    },
    {
      name: "Japanese Mono-ha & Wabi-Sabi",
      description: "Restrained compositions with natural textures, raw material presence, contemplative spacing.",
      enforce: [
        "natural materials emphasis", "stone/wood/paper textures", "ma (spatial pause)",
        "ink wash restraint", "asymmetrical balance"
      ],
      forbid: [
        "loud neon", "busy ornament", "densely packed detail", "chrome/techno polish",
        "digital glitch"
      ],
      palette: ["ink black", "warm paper", "stone gray", "muted earths"],
      surface: ["tactile paper", "raw material grain"]
    },
    {
      name: "Italian High Renaissance Sfumato",
      description: "Harmonic compositions, linear perspective, soft tonal blending, refined sfumato.",
      enforce: [
        "oil on wood panel", "egg-oil tempera underpainting", "layered glazing",
        "soft chiaroscuro", "subtle sfumato", "period lighting"
      ],
      forbid: [
        "neon", "bioluminescent glow", "chrome highlights", "HDR",
        "digital gradients", "vector-clean edges", "lens flare"
      ],
      palette: ["earth tones", "muted primaries", "lead white", "umber", "ochre"],
      surface: ["fine craquelure", "aged varnish bloom", "panel grain"]
    },
    {
      name: "Flemish Baroque Dynamism",
      description: "Diagonal thrust, theatrical staging, saturated colors, lively brushwork with rich glazing.",
      enforce: [
        "oil on canvas", "dynamic diagonals", "rich glazing", "dramatic staging",
        "baroque drapery", "lively brushwork"
      ],
      forbid: [
        "flat vector minimalism", "Memphis patterns", "sci-fi HUD", "neon glow",
        "posterized flatness"
      ],
      palette: ["saturated reds", "deep blacks", "golden highlights", "earth foundations"],
      surface: ["varnished oil sheen", "subtle craquelure", "canvas tooth"]
    },
    {
      name: "Romantic Sublime Landscape",
      description: "Atmospheric grandeur with dramatic skies, luminous light, vast horizons, allegorical nature.",
      enforce: [
        "oil landscape conventions", "dramatic cloudscapes", "aerial perspective",
        "luminous backlight", "epic scale cues"
      ],
      forbid: [
        "flat graphic poster look", "harsh neon", "UI elements",
        "technical linework", "synthetic gradients"
      ],
      palette: ["luminous skies", "forest greens", "warm earths", "cool distances"],
      surface: ["canvas weave", "glazed atmospherics"]
    },
    {
      name: "Impressionist En Plein Air",
      description: "Open-air immediacy with visible strokes, flickering light, vibrating color harmonies.",
      enforce: [
        "visible brushstrokes", "broken color", "plein air spontaneity",
        "optical mixing", "natural light study"
      ],
      forbid: [
        "hard outlines", "polished chrome", "neon graphics", "photographic DOF",
        "perfect gradients"
      ],
      palette: ["pastel lights", "complementary pairs", "sunlit hues"],
      surface: ["oil on canvas", "fresh paint texture"]
    },
    {
      name: "Pointillist Color Theory",
      description: "Systematic optical mixing with precise dots of pure pigment, luminous hues, meticulous stippling.",
      enforce: [
        "pointillist stippling", "pure pigment dots", "optical mixing",
        "systematic mark size", "even field coverage"
      ],
      forbid: [
        "broad impasto strokes", "airbrush blends", "digital gradient fills",
        "neon glow edges", "vector flatness"
      ],
      palette: ["pure primaries", "luminous complements", "restrained gamut"],
      surface: ["oil on canvas", "dot texture field"]
    }
  ]
};
