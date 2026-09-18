import { z } from 'zod';
import { APPEARANCE_FONTS } from '../shared/appearance.js';

const color = z.string().regex(/^#[\da-fA-F]{6}$/);
const palette = z.object({ background: color, sidebar: color, accent: color, contrast: z.number().int().min(0).max(100) });
/** Shared by disk validation and Settings IPC. No authored CSS or remote font URLs. */
export const appearanceSchema = z.object({
  light: palette, dark: palette, font: z.enum(APPEARANCE_FONTS),
  fontSize: z.number().int().min(12).max(18), translucentSidebar: z.boolean(),
  // Follow the desktop explicitly. Absent or malformed reads as off, which is the
  // existing behaviour: no user is switched into follow mode by a parse failure.
  followDesktop: z.boolean().optional()
});
