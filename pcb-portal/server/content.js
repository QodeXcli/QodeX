// Structured content for the programmatic use-case pages (/use-cases/:slug).

export const USE_CASES = [
  {
    slug: 'rf-microwave',
    name: 'RF & microwave',
    menu: 'Controlled-impedance feeds, via fences, IPC-2141A',
    standard: 'IPC-2141A',
    title: 'RF & microwave PCB routing',
    headline: 'Every millimetre of transmission line, accounted for.',
    intro:
      'RF boards fail quietly: a stub that resonates, a ground return that detours around a split, a coplanar gap that drifts with the etch. We route RF feeds as transmission lines first and copper second — solved against your actual stackup, not a default.',
    challenges: [
      ['Impedance drift across layers', 'Microstrip, stripline and grounded coplanar geometries are solved per layer from the dielectric heights and εr in your stackup, then etch-compensated for the target fab.'],
      ['Return-path discontinuities', 'Every RF net is checked against the reference plane beneath it; plane splits and anti-pad voids under a feed are flagged and routed around.'],
      ['Isolation between chains', 'Via fences are stitched along feeds at a pitch derived from the highest frequency of interest, with keep-outs respected around matching networks.'],
    ],
    approach: [
      'Stackup-aware impedance solve (IPC-2141A closed-form, verified against field-solver tables)',
      'Mitred / curved bends only — no 90° corners on RF nets',
      'Via fence and ground-stitch generation with configurable pitch',
      'Matching-network footprints and antenna keep-outs locked, never moved',
    ],
    specs: [
      ['Single-ended target', '50 Ω ±10 %'],
      ['Differential target', '90 / 100 Ω ±10 %'],
      ['Bend geometry', 'Mitred or arc'],
      ['Fence pitch', '≤ λ/20 at f_max'],
    ],
    faq: [
      ['Do you support Rogers or hybrid stackups?', 'Yes. Give us the material and thicknesses per layer (or select them in KiCad’s stackup editor) and impedance is solved from those values.'],
      ['Can you keep my hand-tuned matching network?', 'Lock the footprints and tracks in KiCad (or list them in the order notes). Locked items are carried through byte-for-byte.'],
    ],
  },
  {
    slug: 'high-speed-digital',
    name: 'High-speed digital',
    menu: 'DDR, PCIe, USB and length-matched buses',
    standard: 'IPC-2141A · JEDEC',
    title: 'High-speed digital PCB routing — DDR, PCIe, USB',
    headline: 'Length-matched, skew-bounded, return-path clean.',
    intro:
      'DDR byte lanes, PCIe lanes and USB pairs are routed as constrained groups: impedance, intra-pair skew and inter-lane length windows are solved together, then verified before anything is written back to your board.',
    challenges: [
      ['Byte-lane length windows', 'Data, strobe and mask signals are matched within the window you set, with serpentines placed where they do not couple into neighbours.'],
      ['Intra-pair skew', 'Differential pairs are phase-matched at the bend where the skew is created, not only at the end of the run.'],
      ['Layer transitions', 'Reference-plane changes at vias get stitching vias placed next to the signal via so the return current has a short path.'],
    ],
    approach: [
      'Net classes and diff-pair rules read directly from your KiCad project',
      'Constraint groups for DDR byte lanes, address/command fly-by and PCIe lanes',
      'Skew and length verified by a post-route checker before delivery',
      'Evidence dossier lists every constrained net with its achieved length and skew',
    ],
    specs: [
      ['Pair skew target', 'user-defined (e.g. < 1.5 ps)'],
      ['Length window', 'user-defined per group'],
      ['Diff impedance', '85 / 90 / 100 Ω'],
      ['Stitching', 'at every reference change'],
    ],
    faq: [
      ['Which DDR generations?', 'Routing is constraint-driven, so the same pipeline handles LPDDR4/4X, DDR4 and DDR5 topologies as long as the constraints are provided.'],
      ['Will you change my placement?', 'No. Placement is treated as your design intent. If a constraint is unreachable with the current placement, we report it instead of moving parts.'],
    ],
  },
  {
    slug: 'power-electronics',
    name: 'Power electronics',
    menu: 'Heavy copper, current density, thermal relief',
    standard: 'IPC-2152',
    title: 'Power electronics PCB layout — current density & thermal',
    headline: 'Copper sized for the current, not for the grid.',
    intro:
      'High-current paths are widened from the current you specify and the copper weight you order, using IPC-2152 temperature-rise data. Switching loops are kept tight and gate-drive paths short.',
    challenges: [
      ['Conductor sizing', 'Trace and pour widths are derived from current, copper weight and allowed temperature rise, per IPC-2152.'],
      ['Hot-loop area', 'Input capacitor, switch and diode/sync-FET loops are routed on adjacent layers to minimise loop inductance.'],
      ['Via current capacity', 'Via arrays are sized for the current they carry and placed to spread heat into internal planes.'],
    ],
    approach: [
      'Per-net current annotations from your notes or net-class names',
      'Thermal via arrays under power pads',
      'Creepage and clearance checks for high-voltage net classes',
      '1 oz to 3 oz copper fabrication options',
    ],
    specs: [
      ['Sizing basis', 'IPC-2152'],
      ['Copper weight', '1 – 3 oz'],
      ['HV clearance', 'per net class'],
      ['Thermal vias', 'auto-arrayed'],
    ],
    faq: [
      ['How do I tell you the current per net?', 'Name the net class (e.g. “PWR_10A”) or list the nets and currents in the order notes.'],
      ['Do you do creepage for mains?', 'Clearance and creepage rules are enforced from your net classes; certification remains your responsibility.'],
    ],
  },
  {
    slug: 'mixed-signal',
    name: 'Mixed-signal',
    menu: 'ADC/DAC partitioning and quiet grounds',
    standard: 'IPC-2221',
    title: 'Mixed-signal PCB routing — partitioning and grounding',
    headline: 'Quiet analog, fast digital, one solid ground.',
    intro:
      'Mixed-signal boards need partitioning by placement and discipline in routing: digital return currents must never cross under the analog front end. We route with the return path as a first-class constraint.',
    challenges: [
      ['Return currents under analog', 'Digital nets are kept out of the analog region on every layer, and their return paths are checked against the plane beneath them.'],
      ['Reference and clock hygiene', 'Clock and reference nets are guarded and routed with minimum length and layer changes.'],
      ['Decoupling placement', 'Decoupling capacitors are connected with the shortest via-in-pad or via-adjacent path the fab allows.'],
    ],
    approach: [
      'Region keep-outs derived from rule areas in your KiCad board',
      'Guard traces and stitching for sensitive nets',
      'Solid, unsplit ground by default — splits only where you draw them',
      'Report of every net crossing a region boundary',
    ],
    specs: [
      ['Ground strategy', 'solid reference'],
      ['Guarding', 'per net class'],
      ['Region rules', 'from KiCad rule areas'],
      ['Cross-region report', 'included'],
    ],
    faq: [
      ['Do you split AGND and DGND?', 'Only if your design calls for it. The default is a solid plane with partitioned placement, which is what most modern converters recommend.'],
      ['Can I mark nets as sensitive?', 'Yes — use a net class, or list them in the order notes.'],
    ],
  },
  {
    slug: 'flex-rigid',
    name: 'Flex & rigid-flex',
    menu: 'Bend-aware routing, IPC-2223',
    standard: 'IPC-2223',
    title: 'Flex and rigid-flex PCB routing — IPC-2223',
    headline: 'Routed to bend, not to break.',
    intro:
      'In the flex region copper must follow the rules of a moving part: perpendicular to the bend, curved corners, staggered layers and no vias. We route flex zones with those rules applied automatically.',
    challenges: [
      ['Bend-zone copper', 'Traces cross bend lines at 90°, with arcs instead of corners and staggered positions on adjacent layers.'],
      ['Transitions', 'Rigid-to-flex transitions get teardrops and keep vias outside the stiffener boundary.'],
      ['Hatched planes', 'Planes in the flex region are cross-hatched to preserve flexibility.'],
    ],
    approach: [
      'Bend lines and flex regions read from KiCad user layers / rule areas',
      'No vias or pads inside dynamic bend zones',
      'Automatic teardrops on every flex-region pad',
      'Coverlay openings checked against the fab’s registration tolerance',
    ],
    specs: [
      ['Standard', 'IPC-2223'],
      ['Corners in flex', 'arcs only'],
      ['Vias in bend zone', 'none'],
      ['Planes in flex', 'hatched'],
    ],
    faq: [
      ['Is flex available now?', 'Flex and rigid-flex routing is available on request — mention it in the order notes and we will confirm feasibility before you pay.'],
      ['Static or dynamic flex?', 'Both. Tell us the bend radius and number of cycles and we pick the rules accordingly.'],
    ],
  },
  {
    slug: 'hdi-microvia',
    name: 'HDI & microvia',
    menu: 'Fine-pitch BGA escape, stacked microvias',
    standard: 'IPC-2226',
    title: 'HDI PCB routing — BGA escape and microvias',
    headline: 'Fine-pitch BGA escape, solved rather than fought.',
    intro:
      'Dense BGAs are an escape-routing problem before they are a routing problem. We solve the fan-out pattern ring by ring using the via technology your fab supports — through, blind, buried or laser microvias.',
    challenges: [
      ['Escape ordering', 'Outer rings escape on the top layer; inner rings drop through dog-bone or via-in-pad to lower layers in a planned order.'],
      ['Microvia aspect ratio', 'Microvia and capture-pad sizes follow the aspect ratio and registration limits of the selected fab.'],
      ['Via-in-pad', 'When required, via-in-pad is marked for filling and capping in the fabrication notes.'],
    ],
    approach: [
      'Via technology chosen from your fab profile (through / blind / buried / micro)',
      'Ring-by-ring escape planning for BGAs down to 0.4 mm pitch',
      'Pad-entry teardrops and acid-trap removal at every fan-out',
      'Fab notes for filled and capped via-in-pad',
    ],
    specs: [
      ['Standard', 'IPC-2226'],
      ['BGA pitch', 'down to 0.4 mm'],
      ['Via types', 'through, blind, buried, micro'],
      ['Via-in-pad', 'filled & capped'],
    ],
    faq: [
      ['Which fabs support microvias?', 'Most HDI-capable fabs do; select yours in the order form and the capability limits of that fab are applied.'],
      ['Does HDI cost more?', 'Routing price is driven by nets, pads and layers. Fabrication cost for HDI is quoted separately by the fab.'],
    ],
  },
];

export const USE_CASE_BY_SLUG = new Map(USE_CASES.map((u) => [u.slug, u]));
