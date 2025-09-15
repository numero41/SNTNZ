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
const CHAPTER_DURATION_MINUTES_PROD = 360;

const ROUND_DURATION_SECONDS_DEV = 10;
const CHAPTER_DURATION_MINUTES_DEV = 5;

// --- Dynamically Calculate Values Before Exporting ---
const CHAPTER_DURATION_MINUTES = isProduction ? CHAPTER_DURATION_MINUTES_PROD : CHAPTER_DURATION_MINUTES_DEV;

let HISTORY_CHAPTER_SCHEDULE_CRON;

if (CHAPTER_DURATION_MINUTES < 60) {
  // Case 1: Duration is less than an hour. Use the minute field.
  // Example: For 20 minutes -> '*/20 * * * *'
  HISTORY_CHAPTER_SCHEDULE_CRON = `*/${CHAPTER_DURATION_MINUTES} * * * *`;
} else {
  // Case 2: Duration is one or more hours. Use the hour field.
  const hours = CHAPTER_DURATION_MINUTES / 60;
  if (CHAPTER_DURATION_MINUTES % 60 !== 0) {
    console.warn(`[sntnz config] WARNING: CHAPTER_DURATION_MINUTES (${CHAPTER_DURATION_MINUTES}) is not a clean multiple of 60. The cron schedule may not run as expected.`);
  }

  // Render.com doesn't accept "*/N" in the hours field reliably, so expand manually
  if (Number.isInteger(hours)) {
    const hourList = Array.from({ length: 24 / hours }, (_, i) => i * hours).join(',');
    HISTORY_CHAPTER_SCHEDULE_CRON = `0 ${hourList} * * *`;
  } else {
    HISTORY_CHAPTER_SCHEDULE_CRON = `*/${CHAPTER_DURATION_MINUTES} * * * *`; // fallback
  }
}

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
  BOT_ID: "sntnz_bot",
  AI_TIMEOUT_MS: 50000,

  BOT_STOP_WORDS:['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'of', 'by', 'is', 'am', 'are', 'was', 'were', 'his', 'her', 'its', 'like'],

  // --- MODELS ---
  IMAGEN_MODEL:'imagen-3.0-generate-001',
  GEMINI_MODEL_LITE:'gemini-2.5-flash-lite',
  GEMINI_MODEL_FLASH:'gemini-2.5-flash',
  GEMINI_MODEL_PRO:'gemini-2.5-pro',

  // --- Social Media ---
  DEFAULT_SOCIAL_IMAGE_URL: 'https://storage.googleapis.com/sntnz-assets/default-social-image.png',
  TWITTER_MAX_CHARS: 250,
  IG_MAX_CHARS: 400,
  FB_GRAPH_VERSION: 'v23.0',
  FB_USER_TOKEN_REFRESH_SCHEDULE_CRON: '30 3 * * *',
  SOCIAL_HASHTAGS: '#AIart #GenerativeArt #AutonomousArt #CollaborativeWriting #DigitalLiterature #Automation #AIGenerated #AI #TextToImage #ArtMachine #AIBot #EndlessStory #CollectiveCreativity #CreativeCoding #WritingCommunity #Web3 #DigitalOwnership #NFTart #AIartist #sntnz',
  SOCIAL_X_HASHTAGS: '#AIart #GenerativeArt #CollaborativeWriting #CreativeCoding #sntnz',

  // --- Validation ---
  PUNCTUATION_REGEX_STRING: "^[(\"'*_]*[a-zA-Z0-9'-]+[.,!?;:...\"'_)]*$",

  // --- History ---
  CHAPTER_DURATION_MINUTES: CHAPTER_DURATION_MINUTES,
  HISTORY_CHAPTER_SCHEDULE_CRON: HISTORY_CHAPTER_SCHEDULE_CRON,

  // --- Writing Styles ---
  "WRITING_STYLES": [
    {
      "name": "Tolkien-esque High Fantasy",
      "description": "Formal, epic prose on history, landscapes, and myth.",
      "enforce": [
        "elevated formal prose",
        "archaic vocabulary",
        "mythological undertones",
        "sweeping landscapes",
        "deep history focus",
        "quests & ancient evils",
        "features allegorical, oneiric creatures",
        "surreal, evocative, symbolic tone"
      ]
    },
    {
      "name": "Graphic Novel Narration",
      "description": "Clipped, visual style using short sentences and immediate action.",
      "enforce": [
        "present tense narration",
        "short, declarative sentences",
        "strong active verbs",
        "focus on visual action",
        "internal monologue fragments",
        "cinematic, panel-like descriptions",
        "depicts striking, graphic creatures",
        "surreal, dreamlike (oneiric) atmosphere"
      ]
    },
    {
      "name": "Gothic Thriller",
      "description": "Dark, atmospheric style of psychological dread and suspense.",
      "enforce": [
        "moody, atmospheric tone",
        "psychological suspense",
        "themes of decay & madness",
        "complex, tense sentences",
        "uneasy sensory details",
        "foreshadowing & ambiguity",
        "features ethereal, symbolic creatures",
        "powerful, evocative, oneiric narrative"
      ]
    },
    {
      "name": "Lyrical Romance",
      "description": "Emotive style on feelings and sensory details with figurative language.",
      "enforce": [
        "focus on emotion",
        "rich sensory details",
        "use of metaphor & simile",
        "poetic sentence structure",
        "themes of connection & beauty",
        "intimate perspective",
        "incorporates ethereal, symbolic creatures",
        "resonant, dreamlike (oneiric) quality"
      ]
    },
    {
      "name": "Hard Science Fiction",
      "description": "Precise, technical style about scientific accuracy and problem-solving.",
      "enforce": [
        "technical, precise language",
        "plausible science concepts",
        "focus on technology & systems",
        "analytical narrative",
        "understated, professional tone",
        "themes of discovery & consequence",
        "describes surreal, allegorical aliens",
        "encounter is dreamlike & resonant"
      ]
    },
    {
      "name": "Age of Exploration Journal",
      "description": "First-person observational style mimicking an explorer's log.",
      "enforce": [
        "first-person logbook format",
        "observational & descriptive",
        "sense of wonder",
        "practical, matter-of-fact tone",
        "catalogs new flora & fauna",
        "journey into the unknown",
        "logs discovery of striking, dreamlike creatures",
        "descriptions are evocative & oneiric"
      ]
    },
    {
      "name": "Epic Historical Chronicle",
      "description": "Grand, formal style of sagas, focusing on battles and fate.",
      "enforce": [
        "sweeping, formal narration",
        "details of armies & tactics",
        "themes of lineage & glory",
        "fatalistic undertones",
        "archaic, martial vocabulary",
        "inevitable conflict",
        "chronicles battles with symbolic, dreamlike beasts",
        "resonant, allegorical, ethereal tone"
      ]
    },
    {
      "name": "Mythopoetic (Mythological)",
      "description": "Timeless, allegorical style of oral traditions with archetypes.",
      "enforce": [
        "archetypal characters",
        "cosmic imagery & symbolism",
        "cyclical view of time",
        "elevated, ritual language",
        "themes of fate & sacrifice",
        "sense of timelessness",
        "focus on potent, oneiric creatures",
        "powerfully dreamlike & metaphorical language"
      ]
    },
    {
      "name": "Whimsical Fairy Tale",
      "description": "Playful, surreal style with nonsensical logic and talking beings.",
      "enforce": [
        "whimsical, playful narration",
        "dreamlike, illogical events",
        "talking animals or objects",
        "wordplay & riddles",
        "themes of curiosity & strangeness",
        "lighthearted yet unsettling tone",
        "populated by gripping, surreal creatures",
        "powerfully oneiric & allegorical tale"
      ]
    },
    {
      "name": "Pulp Gothic Horror",
      "description": "Visceral horror with monsters, dread, and melodramatic flair.",
      "enforce": [
        "lurid, sensational descriptions",
        "suspenseful pacing",
        "grotesque imagery",
        "strong emotional reactions",
        "classic horror settings",
        "themes of death & fear",
        "features grotesque, dreamlike creatures",
        "potent, surreal, oneiric dread"
      ]
    },
    {
      "name": "Comic Book Action",
      "description": "Fast, exaggerated, cinematic style with bold, kinetic action.",
      "enforce": [
        "bold exclamations (e.g., 'BAM!')",
        "hyper-dynamic verbs",
        "quick perspective shifts",
        "larger-than-life characters",
        "dramatic one-liners",
        "stylized spectacle",
        "action involves potent, graphic creatures",
        "striking, surreal, dreamlike intensity"
      ]
    },
    {
      "name": "Cinematic Science Fiction",
      "description": "Vivid, cinematic style focused on atmosphere, suspense, and spectacle.",
      "enforce": [
        "atmospheric, visual narration",
        "suspenseful pacing",
        "high-tech meets human vulnerability",
        "focus on survival or awe",
        "precise, not overly technical language",
        "dread to transcendence tone",
        "showcases ethereal, surreal aliens",
        "gripping, dreamlike (oneiric), metaphorical"
      ]
    }
  ],

  // --- Image styles ---
  "IMAGE_STYLES": [
    {
      "name": "Mesoamerican Codex",
      "description": "Manuscript style with bold glyphs and geometric patterns.",
      "enforce": [
        "natural pigments", "bold contour lines", "flat color fields",
        "modular glyphs", "ornamental banding", "screenfold layout",
        "symbolic, allegorical, graphical, resonant aesthetics"
      ],
      "forbid": ["photographic shading", "3D rendering", "neon glow", "lens flare", "airbrush gradients"],
      "palette": ["earth pigments", "cochineal red", "indigo blue", "ochre", "black outline"],
      "surface": ["amate bark paper", "painted codex plate", "matte finish"]
    },
    {
      "name": "Egyptian Papyrus Fresco",
      "description": "New Kingdom style with composite perspective and linear clarity.",
      "enforce": [
        "papyrus texture", "matte mineral pigments", "black outline",
        "composite perspective", "frontal torsos with profile heads", "register lines",
        "evocative, symbolic, allegorical narrative"
      ],
      "forbid": ["realistic perspective", "depth of field", "digital glow", "chrome", "airbrush shading"],
      "palette": ["malachite green", "red ochre", "carbon black", "gypsum white", "earth tones"],
      "surface": ["papyrus fibers", "dry matte paint", "crisp linework"]
    },
    {
      "name": "Mughal Miniature Painting",
      "description": "Courtly manuscript style with fine detail and jeweled palettes.",
      "enforce": [
        "opaque watercolor (gouache)", "gold heightening", "fine brushwork",
        "miniature scale detailing", "isometric gardens", "ornate borders",
        "ethereal, dreamlike, metaphorical scenes"
      ],
      "forbid": ["neon glow", "HDR shine", "vector-clean edges", "spray paint look", "photographic bokeh"],
      "palette": ["jewel tones", "vermilion", "lapis blue", "malachite green", "gold"],
      "surface": ["smooth burnished paper", "illumination sparkle", "album page border"]
    },
    {
      "name": "Japanese Ukiyo-e & Rimpa School",
      "description": "Graphic linework, flat planes, and decorative gold patterns.",
      "enforce": [
        "woodblock print registration", "keyblock outlines", "flat color areas",
        "mica or gold ground", "asymmetrical composition", "kento marks",
        "striking, evocative, graphical, symbolic forms"
      ],
      "forbid": ["oil impasto", "photographic gradients", "lens flare", "3D shading", "HDR glow"],
      "palette": ["indigo", "vermilion", "sumi ink", "gold leaf", "muted dyes"],
      "surface": ["washi paper texture", "woodblock grain hints", "crisp registration"]
    },
    {
      "name": "Dutch Golden Age Chiaroscuro",
      "description": "Oil-on-canvas with dramatic light/dark contrast and glazing.",
      "enforce": [
        "oil on canvas", "layered glazing", "deep chiaroscuro", "warm underpainting",
        "visible brushwork", "soft edge transitions",
        "potent, gripping, metaphorical, dreamlike mood"
      ],
      "forbid": ["neon", "bioluminescent glow", "sci-fi UI", "chrome highlights", "vector-clean edges"],
      "palette": ["earth pigments", "raw umber", "burnt sienna", "lead white", "lamp black"],
      "surface": ["canvas weave", "varnish bloom", "subtle craquelure"]
    },
    {
      "name": "Dynamic Art Nouveau",
      "description": "Ornamental linework, flowing arabesques, and organic asymmetry.",
      "enforce": [
        "lithographic poster feel", "flowing arabesques", "whiplash curves",
        "ornamental frames", "flat decorative fields", "stylized flora",
        "evocative, dreamlike, ethereal, flowing compositions"
      ],
      "forbid": ["hard pixel edges", "industrial sci-fi UI", "chrome mechs", "photoreal", "neon cyber glow"],
      "palette": ["soft pastels", "muted jewel tones", "cream grounds", "gold accents"],
      "surface": ["smooth litho texture", "poster grain", "clean margins"]
    },
    {
      "name": "Streamlined Art Deco",
      "description": "Geometric streamlining, sharp symmetry, and metallic polish.",
      "enforce": [
        "symmetrical layout", "sunburst motifs", "stepped forms", "lacquer sheen",
        "stylized geometry", "architectural ornament",
        "powerful, striking, symbolic, graphical geometry"
      ],
      "forbid": ["messy grunge", "handmade brush chaos", "impressionist dabbling", "low-contrast haze"],
      "palette": ["black", "ivory", "gold", "teal", "crimson accents"],
      "surface": ["lacquer-like panel", "polished metallic cues", "sharp edges"]
    },
    {
      "name": "Generative Glitch Art",
      "description": "Algorithmic distortion, databending, and digital artifacting.",
      "enforce": [
        "scanline artifacts", "datamosh blocks", "RGB channel splits",
        "compression blocks", "spectral waveforms",
        "abstract, surreal, oneiric, potent digital decay"
      ],
      "forbid": ["classical oil brushwork", "paper fiber grain", "antique varnish", "hand-ink line jitter"],
      "palette": ["additive RGB", "CMYK clash", "monochrome noise maps"],
      "surface": ["clean archival print margins", "digital pixel structure"]
    },
    {
      "name": "Anachronic Steampunk Mechanics",
      "description": "Victorian techno-romance with engraved blueprint aesthetics.",
      "enforce": [
        "copperplate engraving lines", "crosshatching", "exploded diagrams",
        "Victorian typography", "machined brass and leather cues",
        "allegorical, symbolic, powerfully intricate designs"
      ],
      "forbid": ["neon cyber glow", "slick chrome futurism", "digital gradients", "soft painterly sfumato"],
      "palette": ["sepia", "ink black", "oxidized brass", "parchment tone"],
      "surface": ["engraving plate feel", "paper grain", "ink impression"]
    },
    {
      "name": "Mid-Century Graphic Optimism",
      "description": "Modernist order with playful geometry, grids, and bold simplicity.",
      "enforce": [
        "silkscreen look", "flat shapes", "geometric forms", "clean grids",
        "simple iconography", "bold figure-ground",
        "graphical, symbolic, resonant, abstract forms"
      ],
      "forbid": ["hyper detail", "oil impasto", "photographic realism", "grunge textures", "complex gradients"],
      "palette": ["cheerful primaries", "pastels", "off-black ink"],
      "surface": ["silkscreen paper", "slight print misregistration"]
    },
    {
      "name": "Psychedelic 70s Funk",
      "description": "Concert-poster style with swirling forms and surreal energy.",
      "enforce": [
        "hand-lettered poster vibes", "swirling contours", "overprint effects",
        "vibrating complementary colors", "trippy motifs",
        "surreal, dreamlike, oneiric, gripping visuals"
      ],
      "forbid": ["classical chiaroscuro", "muted earth-only palette", "photographic bokeh", "sterile vector minimalism"],
      "palette": ["acid brights", "fluorescents", "ink overprints"],
      "surface": ["poster paper", "screenprint grain"]
    },
    {
      "name": "80s Neon & Memphis Design",
      "description": "Bold postmodern style with flat neons and playful geometrics.",
      "enforce": [
        "flat neon planes", "Memphis patterns", "geometric icons",
        "drop shadows", "grid backdrops", "retro vapor motifs",
        "striking, graphical, abstract, dreamlike patterns"
      ],
      "forbid": ["oil canvas weave", "antique paper grain", "Renaissance sfumato", "baroque glazing"],
      "palette": ["electric cyan", "magenta", "yellow", "black", "pastel neons"],
      "surface": ["magazine cover slickness", "clean vector edges"]
    },
    {
      "name": "90s Grunge & Analog Glitch",
      "description": "Layered distressed textures, photocopy wear, and analog-digital hybrid.",
      "enforce": [
        "xerox noise", "tape scuffs", "overprint misalign", "hand-cut collage edges",
        "bitmap halftone", "staple shadows",
        "evocative, gripping, resonant, abstract textures"
      ],
      "forbid": ["polished chrome", "perfect vector edges", "museum varnish gloss", "classical oil blending"],
      "palette": ["dirty blacks", "burnt reds", "acid greens", "desaturated inks"],
      "surface": ["zine paper", "distressed layers", "fold creases"]
    },
    {
      "name": "80s Cyberpunk Anime Opus",
      "description": "High-density technical linework and cinematic, futuristic design.",
      "enforce": [
        "cell-shaded anime", "technical lineart", "retro-futuristic cityscapes",
        "film grain", "theatrical key art",
        "potent, gripping, dreamlike, symbolic cityscapes"
      ],
      "forbid": ["oil impasto", "antique paper fibers", "woodblock registration", "baroque glazing"],
      "palette": ["neon accents", "noctilucent blues", "industrial grays"],
      "surface": ["poster finish", "clean cel lines"]
    },
    {
      "name": "Kubrickian One-Point Perspective",
      "description": "Measured one-point perspective, symmetry, and austere geometry.",
      "enforce": [
        "perfect one-point perspective", "central vanishing point",
        "axial symmetry", "precise framing", "geometric interiors",
        "surreal, oneiric, powerfully symmetrical, allegorical scenes"
      ],
      "forbid": ["tilted camera chaos", "fish-eye distortion", "handheld jitter", "painterly randomness"],
      "palette": ["neutral interiors", "controlled saturation", "clean whites"],
      "surface": ["cinematic poster", "crisp edges"]
    },
    {
      "name": "Lynchian Industrial Surrealism",
      "description": "Industrial textures, eerie atmospherics, and moody monochrome.",
      "enforce": [
        "monochrome or muted tones", "industrial grain", "film-like noise",
        "foggy atmospherics", "uncanny staging",
        "surreal, dreamlike, oneiric, potent, gripping mood"
      ],
      "forbid": ["bright neon palette", "comic-book flatness", "cheerful poster vibes", "classical varnish sheen"],
      "palette": ["soot blacks", "smoky grays", "rust browns"],
      "surface": ["photogravure feel", "velvety blacks"]
    },
    {
      "name": "Abstract Expressionist Gestures",
      "description": "Large-scale expressive gestures, layered paint, and assertive marks.",
      "enforce": [
        "canvas-scale gestures", "drips and splatters", "impasto ridges",
        "layered paint", "energetic brush marks",
        "abstract, powerful, potent, resonant, symbolic gestures"
      ],
      "forbid": ["precise lineart", "vector cleanliness", "technical drafting", "miniature filigree", "neon UI"],
      "palette": ["bold primaries", "earth blacks", "stained canvas tones"],
      "surface": ["raw canvas edges", "thick paint texture"]
    },
    {
      "name": "Bauhaus Functionalist Design",
      "description": "Geometric clarity, strict grids, and functionalist order.",
      "enforce": [
        "modular grids", "geometric primitives", "sans-serif type experiments",
        "asymmetric balance", "functional iconography",
        "graphical, abstract, symbolic, resonant compositions"
      ],
      "forbid": ["baroque ornament", "organic arabesques", "random grunge", "oil glazing textures"],
      "palette": ["black", "white", "primary red", "primary blue", "primary yellow"],
      "surface": ["poster board", "clean print edges"]
    },
    {
      "name": "Expressive Black & White Minimalism",
      "description": "Monochrome with bold contrasts, sharp lines, and minimal forms.",
      "enforce": [
        "high-contrast black and white", "bold shapes", "sharp delineation",
        "negative space discipline", "ink-like marks",
        "striking, graphical, symbolic, powerful, abstract forms"
      ],
      "forbid": ["color gradients", "neon", "busy textures", "photographic color", "ornamental excess"],
      "palette": ["pure black", "paper white"],
      "surface": ["screenprint feel", "smooth poster finish"]
    },
    {
      "name": "Japanese Mono-ha & Wabi-Sabi",
      "description": "Restrained composition with natural textures and contemplative space.",
      "enforce": [
        "natural materials emphasis", "stone/wood/paper textures", "ma (spatial pause)",
        "ink wash restraint", "asymmetrical balance",
        "ethereal, resonant, symbolic, metaphorical arrangements"
      ],
      "forbid": ["loud neon", "busy ornament", "densely packed detail", "chrome/techno polish", "digital glitch"],
      "palette": ["ink black", "warm paper", "stone gray", "muted earths"],
      "surface": ["tactile paper", "raw material grain"]
    },
    {
      "name": "Italian High Renaissance Sfumato",
      "description": "Harmonic composition, linear perspective, and soft tonal blending.",
      "enforce": [
        "oil on wood panel", "egg-oil tempera underpainting", "layered glazing",
        "soft chiaroscuro", "subtle sfumato", "period lighting",
        "ethereal, dreamlike, resonant, allegorical figures"
      ],
      "forbid": ["neon", "bioluminescent glow", "chrome highlights", "HDR", "digital gradients", "lens flare"],
      "palette": ["earth tones", "muted primaries", "lead white", "umber", "ochre"],
      "surface": ["fine craquelure", "aged varnish bloom", "panel grain"]
    },
    {
      "name": "Flemish Baroque Dynamism",
      "description": "Diagonal thrust, theatrical staging, and lively brushwork.",
      "enforce": [
        "oil on canvas", "dynamic diagonals", "rich glazing", "dramatic staging",
        "baroque drapery", "lively brushwork",
        "powerful, gripping, potent, dramatic, allegorical scenes"
      ],
      "forbid": ["flat vector minimalism", "Memphis patterns", "sci-fi HUD", "neon glow", "posterized flatness"],
      "palette": ["saturated reds", "deep blacks", "golden highlights", "earth foundations"],
      "surface": ["varnished oil sheen", "subtle craquelure", "canvas tooth"]
    },
    {
      "name": "Romantic Sublime Landscape",
      "description": "Atmospheric grandeur, dramatic skies, and luminous light.",
      "enforce": [
        "oil landscape conventions", "dramatic cloudscapes", "aerial perspective",
        "luminous backlight", "epic scale cues",
        "evocative, ethereal, dreamlike, powerful landscapes"
      ],
      "forbid": ["flat graphic poster look", "harsh neon", "UI elements", "technical linework"],
      "palette": ["luminous skies", "forest greens", "warm earths", "cool distances"],
      "surface": ["canvas weave", "glazed atmospherics"]
    },
    {
      "name": "Impressionist En Plein Air",
      "description": "Visible strokes, flickering light, and vibrating color harmonies.",
      "enforce": [
        "visible brushstrokes", "broken color", "plein air spontaneity",
        "optical mixing", "natural light study",
        "dreamlike, evocative, ethereal, resonant light"
      ],
      "forbid": ["hard outlines", "polished chrome", "neon graphics", "photographic DOF", "perfect gradients"],
      "palette": ["pastel lights", "complementary pairs", "sunlit hues"],
      "surface": ["oil on canvas", "fresh paint texture"]
    },
    {
      "name": "Pointillist Color Theory",
      "description": "Systematic optical mixing with precise dots of pure pigment.",
      "enforce": [
        "pointillist stippling", "pure pigment dots", "optical mixing",
        "systematic mark size", "even field coverage",
        "abstract, dreamlike, resonant, graphical dot patterns"
      ],
      "forbid": ["broad impasto strokes", "airbrush blends", "digital gradient fills", "neon glow edges"],
      "palette": ["pure primaries", "luminous complements", "restrained gamut"],
      "surface": ["oil on canvas", "dot texture field"]
    }
  ]
};
