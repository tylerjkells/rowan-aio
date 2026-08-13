import type { BrandData } from './types'

/**
 * First-run contents of the Brand guide, distilled from the Rowan University
 * Brand Standards (Graphic Standards Guide 1.4, 2020), pages 19-20 — see
 * docs/brand/rowan-brand-standards-2020.pdf and rowan-colors.json. Once the
 * user edits anything, their copy in brand.json is the source of truth.
 */
export const BRAND_SEED: BrandData = {
  notes: [
    'Always lead with Rowan Brown and Gold; secondary and accent colors are used sparingly.',
    'Limit the number of secondary/accent colors in a single piece.',
    'Red is reserved for CMSRU; do not use in any other context.',
    'Black may be used for text, athletics, and one-color printing; otherwise Rowan Brown or Cold Stone are preferred.',
    'Full fields of brown and gold can be overwhelming; include white space.'
  ],
  typography: {
    primarySans: 'Gotham (8 weights, Thin to Ultra; site license for Book, Book Italic, Bold via publications@rowan.edu)',
    alternatives: ['Source Sans', 'Arial']
  },
  palettes: [
    {
      name: 'Primary',
      colors: [
        { name: 'Rowan Gold', pantone: '7406', cmyk: [0, 20, 100, 2], hex: '#FFCC00' },
        { name: 'Rowan Brown', pantone: '4695', cmyk: [18, 86, 100, 68], hex: '#57150B' },
        { name: 'White', cmyk: [0, 0, 0, 0], hex: '#FFFFFF' }
      ]
    },
    {
      name: 'Recommended tints',
      colors: [
        { name: 'Gold 70%', pantone: '7406 70%', cmyk: [0, 12, 70, 0], hex: '#FFDC69' },
        { name: 'Gold 30%', pantone: '7406 30%', cmyk: [0, 5, 30, 0], hex: '#FFEEBD' },
        { name: 'Brown tint (7517)', pantone: '7517', cmyk: [22, 73, 93, 28], hex: '#88431E' },
        { name: 'Brown tint (4645)', pantone: '4645', cmyk: [28, 50, 70, 8], hex: '#AD7C59' },
        { name: 'Brown tint (4675)', pantone: '4675', cmyk: [7, 20, 30, 6], hex: '#DCBFA6' }
      ]
    },
    {
      name: 'Secondary',
      colors: [
        { name: 'Heritage Gold', pantone: '138', cmyk: [5, 60, 100, 5], hex: '#DE7C00' },
        { name: 'Antique Gold', pantone: '130', cmyk: [5, 40, 100, 5], hex: '#F2A900' },
        { name: 'Medallion', pantone: '7407', cmyk: [10, 30, 80, 10], hex: '#CBA052' },
        { name: 'Cold Stone', pantone: 'Cool Gray 9', cmyk: [0, 0, 0, 65], hex: '#75787B' },
        { name: 'Fossil', pantone: 'Cool Gray 4', cmyk: [0, 0, 0, 30], hex: '#BBBBBB' },
        { name: 'Limestone', pantone: '454', cmyk: [18, 15, 30, 0], hex: '#D2CCB4' },
        { name: 'Furnace', pantone: '5487', cmyk: [60, 35, 45, 15], hex: '#658081' },
        { name: 'Path', pantone: '5435', cmyk: [32, 12, 10, 3], hex: '#A6BECD' },
        { name: 'Pillar', pantone: '7500', cmyk: [3, 7, 25, 2], hex: '#F0E1BE' },
        { name: 'Greensand', pantone: '7736', cmyk: [60, 35, 60, 50], hex: '#395542' },
        { name: 'Slag', pantone: '5777', cmyk: [20, 8, 60, 25], hex: '#A2A569' }
      ]
    },
    {
      name: 'Accent',
      colors: [
        { name: 'Gingko', pantone: '364', cmyk: [70, 30, 100, 25], hex: '#4A7729' },
        { name: 'Sangree(n)', pantone: '376', cmyk: [50, 10, 100, 0], hex: '#84BD00' },
        { name: 'Hollybush', pantone: '7726', cmyk: [100, 30, 90, 10], hex: '#007B4B' },
        { name: 'Whitney Glass', pantone: '7472', cmyk: [54, 0, 27, 0], hex: '#5CB8B2' },
        { name: 'Jersey Blue', pantone: '641', cmyk: [90, 45, 0, 20], hex: '#0067A0' },
        { name: 'Blue Book', pantone: '298', cmyk: [67, 2, 0, 0], hex: '#41B6E6' },
        { name: 'Glassboro Maroon', pantone: '202', cmyk: [5, 95, 65, 45], hex: '#8E142D' },
        // Pantone 873 is a metallic spot ink; this is Pantone's sRGB approximation
        { name: 'Metallic Gold', pantone: '873', hex: '#84754E' }
      ]
    }
  ]
}
