import type { DeviceCategory } from '@prisma/client';

/**
 * Symptom tree + condition-map hotspot content, shared between prisma/seed.ts
 * (fresh companies + the test suite) and scripts/backfill-intake-data.ts (an
 * already-seeded company — seed.ts only runs on a fresh company, so a live
 * company never picks up array changes here on its own).
 */

/**
 * Module 1 (§2 step 4) — the cascading symptom tree.
 *
 * A STARTER tree for handsets, one branch deep enough to show the shape the
 * proposal specifies: Category → Sub-category → Symptom trigger, where only
 * the trigger is selectable. Real centres grow this from their own repair
 * history via the config screen; seeding an exhaustive Samsung fault taxonomy
 * here would be inventing data we cannot verify.
 *
 * `estimateAmount` is the indicative OW labour price the counter quotes at
 * intake (TZS minor units) — the proposal's "preliminary estimate… based on
 * the symptom tree".
 */
export const SYMPTOM_TREE: Array<{
  code: string;
  label: string;
  parent?: string;
  category?: DeviceCategory;
  estimateTzs?: bigint;
  estimateMinutes?: number;
  sortOrder: number;
}> = [
  // -- Display ------------------------------------------------------------
  { code: 'DISPLAY', label: 'Display', category: 'HHP', sortOrder: 10 },
  {
    code: 'DISPLAY.BLANK',
    label: 'No image',
    parent: 'DISPLAY',
    category: 'HHP',
    sortOrder: 10,
  },
  {
    code: 'DISPLAY.BLANK.DEAD',
    label: 'Completely dead — no backlight, no image',
    parent: 'DISPLAY.BLANK',
    category: 'HHP',
    estimateTzs: 45_000_000n,
    estimateMinutes: 90,
    sortOrder: 10,
  },
  {
    code: 'DISPLAY.BLANK.BACKLIGHT_ONLY',
    label: 'Backlight on, no image',
    parent: 'DISPLAY.BLANK',
    category: 'HHP',
    estimateTzs: 45_000_000n,
    estimateMinutes: 90,
    sortOrder: 20,
  },
  {
    code: 'DISPLAY.BACKLIGHT',
    label: 'Backlight',
    parent: 'DISPLAY',
    category: 'HHP',
    sortOrder: 20,
  },
  {
    code: 'DISPLAY.BACKLIGHT.WARM_FLICKER',
    label: 'Flickers only when warm',
    parent: 'DISPLAY.BACKLIGHT',
    category: 'HHP',
    estimateTzs: 45_000_000n,
    estimateMinutes: 120,
    sortOrder: 10,
  },
  {
    code: 'DISPLAY.TOUCH',
    label: 'Touch',
    parent: 'DISPLAY',
    category: 'HHP',
    sortOrder: 30,
  },
  {
    code: 'DISPLAY.TOUCH.DEAD_ZONE',
    label: 'Dead zone in one area',
    parent: 'DISPLAY.TOUCH',
    category: 'HHP',
    estimateTzs: 45_000_000n,
    estimateMinutes: 90,
    sortOrder: 10,
  },
  {
    code: 'DISPLAY.TOUCH.GHOST',
    label: 'Ghost touches / responds untouched',
    parent: 'DISPLAY.TOUCH',
    category: 'HHP',
    estimateTzs: 45_000_000n,
    estimateMinutes: 90,
    sortOrder: 20,
  },
  // -- Power / charging ---------------------------------------------------
  { code: 'POWER', label: 'Power & charging', category: 'HHP', sortOrder: 20 },
  {
    code: 'POWER.CHARGING',
    label: 'Charging',
    parent: 'POWER',
    category: 'HHP',
    sortOrder: 10,
  },
  {
    code: 'POWER.CHARGING.NONE',
    label: 'Does not charge at all',
    parent: 'POWER.CHARGING',
    category: 'HHP',
    estimateTzs: 3_500_000n,
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'POWER.CHARGING.INTERMITTENT',
    label: 'Charges only at a certain cable angle',
    parent: 'POWER.CHARGING',
    category: 'HHP',
    estimateTzs: 3_500_000n,
    estimateMinutes: 60,
    sortOrder: 20,
  },
  {
    code: 'POWER.BATTERY',
    label: 'Battery',
    parent: 'POWER',
    category: 'HHP',
    sortOrder: 20,
  },
  {
    code: 'POWER.BATTERY.DRAIN',
    label: 'Drains within a few hours',
    parent: 'POWER.BATTERY',
    category: 'HHP',
    estimateTzs: 5_500_000n,
    estimateMinutes: 45,
    sortOrder: 10,
  },
  {
    code: 'POWER.BATTERY.SWOLLEN',
    label: 'Swollen / lifting the back cover',
    parent: 'POWER.BATTERY',
    category: 'HHP',
    estimateTzs: 5_500_000n,
    estimateMinutes: 45,
    sortOrder: 20,
  },
  {
    code: 'POWER.DEAD',
    label: 'Will not power on',
    parent: 'POWER',
    category: 'HHP',
    sortOrder: 30,
  },
  {
    code: 'POWER.DEAD.NO_RESPONSE',
    label: 'No response at all, even on charger',
    parent: 'POWER.DEAD',
    category: 'HHP',
    estimateTzs: 2_000_000n,
    estimateMinutes: 60,
    sortOrder: 10,
  },
  // -- Software -----------------------------------------------------------
  { code: 'SOFTWARE', label: 'Software', category: 'HHP', sortOrder: 30 },
  {
    code: 'SOFTWARE.BOOT',
    label: 'Boot',
    parent: 'SOFTWARE',
    category: 'HHP',
    sortOrder: 10,
  },
  {
    code: 'SOFTWARE.BOOT.LOOP',
    label: 'Restarts in a loop at the logo',
    parent: 'SOFTWARE.BOOT',
    category: 'HHP',
    estimateTzs: 2_000_000n,
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'SOFTWARE.LOCK',
    label: 'Lock',
    parent: 'SOFTWARE',
    category: 'HHP',
    sortOrder: 20,
  },
  {
    code: 'SOFTWARE.LOCK.FRP',
    label: 'Google account (FRP) lock after reset',
    parent: 'SOFTWARE.LOCK',
    category: 'HHP',
    estimateTzs: 2_000_000n,
    estimateMinutes: 45,
    sortOrder: 10,
  },
  // -- Liquid damage ------------------------------------------------------
  { code: 'LIQUID', label: 'Liquid damage', category: 'HHP', sortOrder: 40 },
  {
    code: 'LIQUID.EXPOSURE',
    label: 'Exposure',
    parent: 'LIQUID',
    category: 'HHP',
    sortOrder: 10,
  },
  {
    code: 'LIQUID.EXPOSURE.SUBMERGED',
    label: 'Submerged / dropped in liquid',
    parent: 'LIQUID.EXPOSURE',
    category: 'HHP',
    estimateMinutes: 120,
    sortOrder: 10,
  },
  {
    code: 'LIQUID.EXPOSURE.SPLASH',
    label: 'Splashed, still partly working',
    parent: 'LIQUID.EXPOSURE',
    category: 'HHP',
    estimateMinutes: 120,
    sortOrder: 20,
  },
  // -- Camera ---------------------------------------------------------------
  { code: 'CAMERA', label: 'Camera', category: 'HHP', sortOrder: 50 },
  {
    code: 'CAMERA.REAR_BLUR',
    label: 'Rear camera blurry / out of focus',
    parent: 'CAMERA',
    category: 'HHP',
    estimateTzs: 12_000_000n, // TZS 120,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'CAMERA.FRONT_DEAD',
    label: 'Front camera not working',
    parent: 'CAMERA',
    category: 'HHP',
    estimateTzs: 8_000_000n, // TZS 80,000
    estimateMinutes: 45,
    sortOrder: 20,
  },
  {
    code: 'CAMERA.APP_CRASH',
    label: 'Camera app crashes on open',
    parent: 'CAMERA',
    category: 'HHP',
    estimateMinutes: 45,
    sortOrder: 30,
  },
  // -- Audio ------------------------------------------------------------------
  { code: 'AUDIO', label: 'Audio', category: 'HHP', sortOrder: 60 },
  {
    code: 'AUDIO.SPEAKER_DISTORTED',
    label: 'Speaker distorted or crackling',
    parent: 'AUDIO',
    category: 'HHP',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 45,
    sortOrder: 10,
  },
  {
    code: 'AUDIO.SPEAKER_SILENT',
    label: 'No sound from speaker',
    parent: 'AUDIO',
    category: 'HHP',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 45,
    sortOrder: 20,
  },
  {
    code: 'AUDIO.MIC_NOT_PICKING_UP',
    label: 'Microphone not picking up voice',
    parent: 'AUDIO',
    category: 'HHP',
    estimateTzs: 3_500_000n, // TZS 35,000
    estimateMinutes: 45,
    sortOrder: 30,
  },
  {
    code: 'AUDIO.EARPIECE_CRACKLE',
    label: 'Earpiece crackling on calls',
    parent: 'AUDIO',
    category: 'HHP',
    estimateTzs: 2_500_000n, // TZS 25,000
    estimateMinutes: 30,
    sortOrder: 40,
  },
  // -- Connectivity -----------------------------------------------------------
  { code: 'CONNECTIVITY', label: 'Connectivity', category: 'HHP', sortOrder: 70 },
  {
    code: 'CONNECTIVITY.WIFI',
    label: "Won't connect to Wi-Fi",
    parent: 'CONNECTIVITY',
    category: 'HHP',
    estimateTzs: 6_000_000n, // TZS 60,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'CONNECTIVITY.BLUETOOTH',
    label: 'Bluetooth pairing fails',
    parent: 'CONNECTIVITY',
    category: 'HHP',
    estimateTzs: 6_000_000n, // TZS 60,000
    estimateMinutes: 60,
    sortOrder: 20,
  },
  {
    code: 'CONNECTIVITY.NO_SIGNAL',
    label: 'No cellular signal / signal drops',
    parent: 'CONNECTIVITY',
    category: 'HHP',
    estimateTzs: 7_000_000n, // TZS 70,000
    estimateMinutes: 60,
    sortOrder: 30,
  },
  {
    code: 'CONNECTIVITY.SIM_NOT_DETECTED',
    label: 'SIM card not detected',
    parent: 'CONNECTIVITY',
    category: 'HHP',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 30,
    sortOrder: 40,
  },
  // -- Buttons & sensors --------------------------------------------------------
  { code: 'BUTTONS', label: 'Buttons & sensors', category: 'HHP', sortOrder: 80 },
  {
    code: 'BUTTONS.POWER_UNRESPONSIVE',
    label: 'Power button unresponsive',
    parent: 'BUTTONS',
    category: 'HHP',
    estimateTzs: 2_500_000n, // TZS 25,000
    estimateMinutes: 30,
    sortOrder: 10,
  },
  {
    code: 'BUTTONS.VOLUME_STUCK',
    label: 'Volume button stuck / not registering',
    parent: 'BUTTONS',
    category: 'HHP',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 30,
    sortOrder: 20,
  },
  {
    code: 'BUTTONS.FINGERPRINT_FAIL',
    label: 'Fingerprint sensor not recognising',
    parent: 'BUTTONS',
    category: 'HHP',
    estimateTzs: 4_500_000n, // TZS 45,000
    estimateMinutes: 45,
    sortOrder: 30,
  },
  // -- Overheating --------------------------------------------------------------
  { code: 'THERMAL', label: 'Overheating', category: 'HHP', sortOrder: 90 },
  {
    code: 'THERMAL.DURING_USE',
    label: 'Overheats during normal use',
    parent: 'THERMAL',
    category: 'HHP',
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'THERMAL.WHILE_CHARGING',
    label: 'Overheats while charging',
    parent: 'THERMAL',
    category: 'HHP',
    estimateMinutes: 60,
    sortOrder: 20,
  },

  // ===========================================================================
  // CE — TV / consumer electronics
  // ===========================================================================
  { code: 'CE_PICTURE', label: 'Picture', category: 'CE', sortOrder: 10 },
  {
    code: 'CE_PICTURE.NONE',
    label: 'No picture (black screen)',
    parent: 'CE_PICTURE',
    category: 'CE',
    estimateTzs: 40_000_000n, // TZS 400,000
    estimateMinutes: 120,
    sortOrder: 10,
  },
  {
    code: 'CE_PICTURE.NO_SOUND',
    label: 'Picture but no sound',
    parent: 'CE_PICTURE',
    category: 'CE',
    estimateTzs: 15_000_000n, // TZS 150,000
    estimateMinutes: 60,
    sortOrder: 20,
  },
  {
    code: 'CE_PICTURE.DISTORTED',
    label: 'Distorted or lined picture',
    parent: 'CE_PICTURE',
    category: 'CE',
    estimateTzs: 40_000_000n, // TZS 400,000
    estimateMinutes: 150,
    sortOrder: 30,
  },
  {
    code: 'CE_PICTURE.BACKLIGHT_FLICKER',
    label: 'Backlight flickering',
    parent: 'CE_PICTURE',
    category: 'CE',
    estimateTzs: 35_000_000n, // TZS 350,000
    estimateMinutes: 120,
    sortOrder: 40,
  },
  {
    code: 'CE_PICTURE.BURN_IN',
    label: 'Screen burn-in / ghosting',
    parent: 'CE_PICTURE',
    category: 'CE',
    estimateMinutes: 45,
    sortOrder: 50,
  },
  { code: 'CE_SOUND', label: 'Sound', category: 'CE', sortOrder: 20 },
  {
    code: 'CE_SOUND.NONE',
    label: 'No sound',
    parent: 'CE_SOUND',
    category: 'CE',
    estimateTzs: 15_000_000n, // TZS 150,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'CE_SOUND.WITH_NO_PICTURE',
    label: 'Sound but no picture',
    parent: 'CE_SOUND',
    category: 'CE',
    estimateTzs: 40_000_000n, // TZS 400,000
    estimateMinutes: 120,
    sortOrder: 20,
  },
  {
    code: 'CE_SOUND.DISTORTED',
    label: 'Distorted or crackling audio',
    parent: 'CE_SOUND',
    category: 'CE',
    estimateTzs: 10_000_000n, // TZS 100,000
    estimateMinutes: 45,
    sortOrder: 30,
  },
  { code: 'CE_POWER', label: 'Power', category: 'CE', sortOrder: 30 },
  {
    code: 'CE_POWER.NONE',
    label: "Won't power on at all",
    parent: 'CE_POWER',
    category: 'CE',
    estimateTzs: 12_000_000n, // TZS 120,000
    estimateMinutes: 90,
    sortOrder: 10,
  },
  {
    code: 'CE_POWER.SHUTS_OFF',
    label: 'Powers on then shuts off',
    parent: 'CE_POWER',
    category: 'CE',
    estimateTzs: 12_000_000n, // TZS 120,000
    estimateMinutes: 90,
    sortOrder: 20,
  },
  {
    code: 'CE_POWER.STANDBY_BLINK',
    label: 'Standby light blinking (error code)',
    parent: 'CE_POWER',
    category: 'CE',
    estimateTzs: 12_000_000n, // TZS 120,000
    estimateMinutes: 90,
    sortOrder: 30,
  },
  {
    code: 'CE_CONNECTIVITY',
    label: 'Connectivity',
    category: 'CE',
    sortOrder: 40,
  },
  {
    code: 'CE_CONNECTIVITY.HDMI',
    label: 'HDMI port not detected',
    parent: 'CE_CONNECTIVITY',
    category: 'CE',
    estimateTzs: 2_500_000n, // TZS 25,000
    estimateMinutes: 30,
    sortOrder: 10,
  },
  {
    code: 'CE_CONNECTIVITY.SMART',
    label: 'Smart features / Wi-Fi not connecting',
    parent: 'CE_CONNECTIVITY',
    category: 'CE',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 30,
    sortOrder: 20,
  },
  {
    code: 'CE_CONNECTIVITY.REMOTE',
    label: 'Remote control unresponsive',
    parent: 'CE_CONNECTIVITY',
    category: 'CE',
    estimateTzs: 1_000_000n, // TZS 10,000
    estimateMinutes: 15,
    sortOrder: 30,
  },

  // ===========================================================================
  // AC — air conditioning
  // ===========================================================================
  { code: 'AC_COOLING', label: 'Cooling', category: 'AC', sortOrder: 10 },
  {
    code: 'AC_COOLING.NONE_COMPRESSOR',
    label: 'Not cooling — compressor not running',
    parent: 'AC_COOLING',
    category: 'AC',
    estimateTzs: 55_000_000n, // TZS 550,000
    estimateMinutes: 120,
    sortOrder: 10,
  },
  {
    code: 'AC_COOLING.NONE_GAS',
    label: 'Not cooling — suspected low gas',
    parent: 'AC_COOLING',
    category: 'AC',
    estimateTzs: 20_000_000n, // TZS 200,000
    estimateMinutes: 90,
    sortOrder: 20,
  },
  {
    code: 'AC_COOLING.WEAK_FILTER',
    label: 'Weak airflow — blocked / dirty filter',
    parent: 'AC_COOLING',
    category: 'AC',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 30,
    sortOrder: 30,
  },
  {
    code: 'AC_COOLING.WEAK_FAN',
    label: 'Weak airflow — fan motor fault',
    parent: 'AC_COOLING',
    category: 'AC',
    estimateTzs: 6_000_000n, // TZS 60,000
    estimateMinutes: 60,
    sortOrder: 40,
  },
  {
    code: 'AC_COOLING.WARM_AIR',
    label: 'Blows warm air',
    parent: 'AC_COOLING',
    category: 'AC',
    estimateTzs: 20_000_000n, // TZS 200,000
    estimateMinutes: 90,
    sortOrder: 50,
  },
  { code: 'AC_NOISE', label: 'Noise & vibration', category: 'AC', sortOrder: 20 },
  {
    code: 'AC_NOISE.INDOOR',
    label: 'Rattling from indoor unit',
    parent: 'AC_NOISE',
    category: 'AC',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 45,
    sortOrder: 10,
  },
  {
    code: 'AC_NOISE.OUTDOOR',
    label: 'Rattling from outdoor unit',
    parent: 'AC_NOISE',
    category: 'AC',
    estimateTzs: 2_500_000n, // TZS 25,000
    estimateMinutes: 60,
    sortOrder: 20,
  },
  { code: 'AC_LEAKS', label: 'Leaks', category: 'AC', sortOrder: 30 },
  {
    code: 'AC_LEAKS.INDOOR',
    label: 'Water leaking from indoor unit',
    parent: 'AC_LEAKS',
    category: 'AC',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'AC_LEAKS.OUTDOOR',
    label: 'Water leaking from outdoor unit',
    parent: 'AC_LEAKS',
    category: 'AC',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 60,
    sortOrder: 20,
  },
  { code: 'AC_ELECTRICAL', label: 'Electrical', category: 'AC', sortOrder: 40 },
  {
    code: 'AC_ELECTRICAL.NO_POWER',
    label: "Won't power on",
    parent: 'AC_ELECTRICAL',
    category: 'AC',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'AC_ELECTRICAL.REMOTE',
    label: 'Remote control unresponsive',
    parent: 'AC_ELECTRICAL',
    category: 'AC',
    estimateTzs: 1_500_000n, // TZS 15,000
    estimateMinutes: 15,
    sortOrder: 20,
  },
  {
    code: 'AC_ELECTRICAL.TRIPS_BREAKER',
    label: 'Trips the circuit breaker',
    parent: 'AC_ELECTRICAL',
    category: 'AC',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 60,
    sortOrder: 30,
  },
  { code: 'AC_ODOUR', label: 'Odour', category: 'AC', sortOrder: 50 },
  {
    code: 'AC_ODOUR.BAD_SMELL',
    label: 'Bad smell when running',
    parent: 'AC_ODOUR',
    category: 'AC',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 45,
    sortOrder: 10,
  },
  {
    code: 'AC_ODOUR.MUSTY',
    label: 'Musty smell (suspected mould)',
    parent: 'AC_ODOUR',
    category: 'AC',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 60,
    sortOrder: 20,
  },

  // ===========================================================================
  // REF — refrigeration
  // ===========================================================================
  { code: 'REF_COOLING', label: 'Cooling', category: 'REF', sortOrder: 10 },
  {
    code: 'REF_COOLING.COMPRESSOR',
    label: 'Not cooling — compressor not running',
    parent: 'REF_COOLING',
    category: 'REF',
    estimateTzs: 60_000_000n, // TZS 600,000
    estimateMinutes: 120,
    sortOrder: 10,
  },
  {
    code: 'REF_COOLING.GAS_LOW',
    label: 'Not cooling — suspected low gas',
    parent: 'REF_COOLING',
    category: 'REF',
    estimateTzs: 22_000_000n, // TZS 220,000
    estimateMinutes: 90,
    sortOrder: 20,
  },
  {
    code: 'REF_COOLING.FREEZER_WARM',
    label: 'Freezer not freezing',
    parent: 'REF_COOLING',
    category: 'REF',
    estimateTzs: 22_000_000n, // TZS 220,000
    estimateMinutes: 90,
    sortOrder: 30,
  },
  {
    code: 'REF_COOLING.UNEVEN',
    label: 'Uneven cooling — circulation fan fault',
    parent: 'REF_COOLING',
    category: 'REF',
    estimateTzs: 5_000_000n, // TZS 50,000
    estimateMinutes: 60,
    sortOrder: 40,
  },
  { code: 'REF_NOISE', label: 'Noise', category: 'REF', sortOrder: 20 },
  {
    code: 'REF_NOISE.COMPRESSOR_HUM',
    label: 'Compressor humming loudly',
    parent: 'REF_NOISE',
    category: 'REF',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 45,
    sortOrder: 10,
  },
  {
    code: 'REF_NOISE.CLICKING',
    label: 'Clicking or buzzing noise',
    parent: 'REF_NOISE',
    category: 'REF',
    estimateTzs: 2_500_000n, // TZS 25,000
    estimateMinutes: 45,
    sortOrder: 20,
  },
  { code: 'REF_ICE_FROST', label: 'Ice & frost', category: 'REF', sortOrder: 30 },
  {
    code: 'REF_ICE_FROST.EXCESS_FROST',
    label: 'Excessive frost buildup',
    parent: 'REF_ICE_FROST',
    category: 'REF',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'REF_ICE_FROST.MAKER_DEAD',
    label: 'Ice maker not working',
    parent: 'REF_ICE_FROST',
    category: 'REF',
    estimateTzs: 6_000_000n, // TZS 60,000
    estimateMinutes: 60,
    sortOrder: 20,
  },
  {
    code: 'REF_ICE_FROST.MAKER_LEAK',
    label: 'Ice maker leaking',
    parent: 'REF_ICE_FROST',
    category: 'REF',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 45,
    sortOrder: 30,
  },
  { code: 'REF_DOORS', label: 'Doors & seals', category: 'REF', sortOrder: 40 },
  {
    code: 'REF_DOORS.SEAL_FAIL',
    label: "Door seal doesn't hold (gasket)",
    parent: 'REF_DOORS',
    category: 'REF',
    estimateTzs: 4_000_000n, // TZS 40,000
    estimateMinutes: 30,
    sortOrder: 10,
  },
  {
    code: 'REF_DOORS.WONT_CLOSE',
    label: "Door won't close properly",
    parent: 'REF_DOORS',
    category: 'REF',
    estimateTzs: 2_000_000n, // TZS 20,000
    estimateMinutes: 30,
    sortOrder: 20,
  },
  {
    code: 'REF_ELECTRICAL',
    label: 'Electrical',
    category: 'REF',
    sortOrder: 50,
  },
  {
    code: 'REF_ELECTRICAL.NO_POWER',
    label: "Won't power on",
    parent: 'REF_ELECTRICAL',
    category: 'REF',
    estimateTzs: 3_000_000n, // TZS 30,000
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'REF_ELECTRICAL.LIGHT_OUT',
    label: 'Interior light not working',
    parent: 'REF_ELECTRICAL',
    category: 'REF',
    estimateTzs: 1_000_000n, // TZS 10,000
    estimateMinutes: 20,
    sortOrder: 20,
  },

  // ===========================================================================
  // OTHER — generic catch-all
  // ===========================================================================
  { code: 'GENERAL', label: 'General', category: 'OTHER', sortOrder: 10 },
  {
    code: 'GENERAL.NO_POWER',
    label: "Won't power on",
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 60,
    sortOrder: 10,
  },
  {
    code: 'GENERAL.INTERMITTENT',
    label: 'Works intermittently',
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 60,
    sortOrder: 20,
  },
  {
    code: 'GENERAL.PHYSICAL_DAMAGE',
    label: 'Visible physical damage',
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 45,
    sortOrder: 30,
  },
  {
    code: 'GENERAL.NOISE',
    label: 'Unusual noise',
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 45,
    sortOrder: 40,
  },
  {
    code: 'GENERAL.OVERHEATING',
    label: 'Overheating',
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 45,
    sortOrder: 50,
  },
  {
    code: 'GENERAL.ERROR_CODE',
    label: 'Error code displayed',
    parent: 'GENERAL',
    category: 'OTHER',
    estimateMinutes: 30,
    sortOrder: 60,
  },
];

/**
 * Module 1 (§2 step 3) — the interactive condition map's hotspots.
 *
 * Normalised 0–1 coordinates on a device outline, so one renderer draws a
 * handset, a TV and a fridge from the same data. A starter layout per class.
 */
export const CONDITION_ZONES: Array<{
  category: DeviceCategory;
  code: string;
  label: string;
  x: number;
  y: number;
  face: string;
  sortOrder: number;
}> = [
  // Handset — front
  {
    category: 'HHP',
    code: 'SCREEN_TL',
    label: 'Screen — top left',
    x: 0.28,
    y: 0.2,
    face: 'FRONT',
    sortOrder: 10,
  },
  {
    category: 'HHP',
    code: 'SCREEN_TR',
    label: 'Screen — top right',
    x: 0.72,
    y: 0.2,
    face: 'FRONT',
    sortOrder: 20,
  },
  {
    category: 'HHP',
    code: 'SCREEN_C',
    label: 'Screen — centre',
    x: 0.5,
    y: 0.5,
    face: 'FRONT',
    sortOrder: 30,
  },
  {
    category: 'HHP',
    code: 'SCREEN_BL',
    label: 'Screen — bottom left',
    x: 0.28,
    y: 0.8,
    face: 'FRONT',
    sortOrder: 40,
  },
  {
    category: 'HHP',
    code: 'SCREEN_BR',
    label: 'Screen — bottom right',
    x: 0.72,
    y: 0.8,
    face: 'FRONT',
    sortOrder: 50,
  },
  {
    category: 'HHP',
    code: 'EARPIECE',
    label: 'Earpiece / front camera',
    x: 0.5,
    y: 0.07,
    face: 'FRONT',
    sortOrder: 60,
  },
  // Handset — back & sides
  {
    category: 'HHP',
    code: 'BACK_GLASS',
    label: 'Back panel',
    x: 0.5,
    y: 0.55,
    face: 'BACK',
    sortOrder: 70,
  },
  {
    category: 'HHP',
    code: 'CAMERA_BUMP',
    label: 'Rear camera housing',
    x: 0.28,
    y: 0.14,
    face: 'BACK',
    sortOrder: 80,
  },
  {
    category: 'HHP',
    code: 'FRAME_LEFT',
    label: 'Left frame / volume keys',
    x: 0.04,
    y: 0.35,
    face: 'SIDE',
    sortOrder: 90,
  },
  {
    category: 'HHP',
    code: 'FRAME_RIGHT',
    label: 'Right frame / power key',
    x: 0.96,
    y: 0.35,
    face: 'SIDE',
    sortOrder: 100,
  },
  {
    category: 'HHP',
    code: 'PORT',
    label: 'Charging port / speaker',
    x: 0.5,
    y: 0.97,
    face: 'SIDE',
    sortOrder: 110,
  },
  {
    category: 'HHP',
    code: 'SIM_TRAY',
    label: 'SIM tray',
    x: 0.04,
    y: 0.12,
    face: 'SIDE',
    sortOrder: 120,
  },
  {
    category: 'HHP',
    code: 'LDI',
    label: 'Liquid damage indicator',
    x: 0.1,
    y: 0.9,
    face: 'SIDE',
    sortOrder: 130,
  },
  // TV / consumer electronics
  {
    category: 'CE',
    code: 'PANEL_TL',
    label: 'Panel — top left',
    x: 0.25,
    y: 0.25,
    face: 'FRONT',
    sortOrder: 10,
  },
  {
    category: 'CE',
    code: 'PANEL_C',
    label: 'Panel — centre',
    x: 0.5,
    y: 0.45,
    face: 'FRONT',
    sortOrder: 20,
  },
  {
    category: 'CE',
    code: 'PANEL_BR',
    label: 'Panel — bottom right',
    x: 0.75,
    y: 0.7,
    face: 'FRONT',
    sortOrder: 30,
  },
  {
    category: 'CE',
    code: 'BEZEL',
    label: 'Bezel / frame',
    x: 0.5,
    y: 0.05,
    face: 'FRONT',
    sortOrder: 40,
  },
  {
    category: 'CE',
    code: 'STAND',
    label: 'Stand / wall mount',
    x: 0.5,
    y: 0.95,
    face: 'FRONT',
    sortOrder: 50,
  },
  {
    category: 'CE',
    code: 'PORTS',
    label: 'Rear port bank',
    x: 0.75,
    y: 0.55,
    face: 'BACK',
    sortOrder: 60,
  },
  {
    category: 'CE',
    code: 'BACK_COVER',
    label: 'Rear cover',
    x: 0.4,
    y: 0.5,
    face: 'BACK',
    sortOrder: 70,
  },
  // Air conditioning
  {
    category: 'AC',
    code: 'INDOOR_FASCIA',
    label: 'Indoor unit fascia',
    x: 0.5,
    y: 0.3,
    face: 'FRONT',
    sortOrder: 10,
  },
  {
    category: 'AC',
    code: 'LOUVRE',
    label: 'Air louvre / vanes',
    x: 0.5,
    y: 0.6,
    face: 'FRONT',
    sortOrder: 20,
  },
  {
    category: 'AC',
    code: 'FILTER',
    label: 'Filter housing',
    x: 0.3,
    y: 0.45,
    face: 'FRONT',
    sortOrder: 30,
  },
  {
    category: 'AC',
    code: 'OUTDOOR_FINS',
    label: 'Outdoor unit fins',
    x: 0.5,
    y: 0.5,
    face: 'BACK',
    sortOrder: 40,
  },
  {
    category: 'AC',
    code: 'PIPEWORK',
    label: 'Pipework / insulation',
    x: 0.8,
    y: 0.75,
    face: 'BACK',
    sortOrder: 50,
  },
  // Refrigeration
  {
    category: 'REF',
    code: 'DOOR_UPPER',
    label: 'Upper door',
    x: 0.5,
    y: 0.25,
    face: 'FRONT',
    sortOrder: 10,
  },
  {
    category: 'REF',
    code: 'DOOR_LOWER',
    label: 'Lower door',
    x: 0.5,
    y: 0.7,
    face: 'FRONT',
    sortOrder: 20,
  },
  {
    category: 'REF',
    code: 'GASKET',
    label: 'Door gasket / seal',
    x: 0.12,
    y: 0.45,
    face: 'FRONT',
    sortOrder: 30,
  },
  {
    category: 'REF',
    code: 'HANDLE',
    label: 'Handle',
    x: 0.85,
    y: 0.4,
    face: 'FRONT',
    sortOrder: 40,
  },
  {
    category: 'REF',
    code: 'INTERIOR',
    label: 'Interior / shelving',
    x: 0.5,
    y: 0.5,
    face: 'FRONT',
    sortOrder: 50,
  },
  {
    category: 'REF',
    code: 'COMPRESSOR',
    label: 'Compressor bay',
    x: 0.5,
    y: 0.9,
    face: 'BACK',
    sortOrder: 60,
  },
  {
    category: 'REF',
    code: 'SIDE_PANEL',
    label: 'Side panel',
    x: 0.05,
    y: 0.5,
    face: 'SIDE',
    sortOrder: 70,
  },
  // Handset — new hotspots not already covered above
  {
    category: 'HHP',
    code: 'HOME_AREA',
    label: 'Home button / fingerprint area',
    x: 0.5,
    y: 0.93,
    face: 'FRONT',
    sortOrder: 140,
  },
  {
    category: 'HHP',
    code: 'FINGERPRINT_BACK',
    label: 'Fingerprint sensor (back)',
    x: 0.5,
    y: 0.3,
    face: 'BACK',
    sortOrder: 150,
  },
  {
    category: 'HHP',
    code: 'HEADPHONE_JACK',
    label: 'Headphone jack',
    x: 0.2,
    y: 0.97,
    face: 'SIDE',
    sortOrder: 160,
  },
  // TV / consumer electronics — new hotspots (existing PANEL_TL/PANEL_C/
  // PANEL_BR left two corners uncovered)
  {
    category: 'CE',
    code: 'PANEL_TR',
    label: 'Panel — top right',
    x: 0.75,
    y: 0.25,
    face: 'FRONT',
    sortOrder: 80,
  },
  {
    category: 'CE',
    code: 'PANEL_BL',
    label: 'Panel — bottom left',
    x: 0.25,
    y: 0.7,
    face: 'FRONT',
    sortOrder: 90,
  },
  {
    category: 'CE',
    code: 'SPEAKER_GRILLE',
    label: 'Speaker grille',
    x: 0.5,
    y: 0.8,
    face: 'BACK',
    sortOrder: 100,
  },
  {
    category: 'CE',
    code: 'SIDE_CONTROLS',
    label: 'Side buttons / controls',
    x: 0.9,
    y: 0.3,
    face: 'SIDE',
    sortOrder: 110,
  },
  {
    category: 'CE',
    code: 'USB_PORT',
    label: 'USB port',
    x: 0.5,
    y: 0.4,
    face: 'SIDE',
    sortOrder: 120,
  },
  // Air conditioning — new hotspots
  {
    category: 'AC',
    code: 'DISPLAY_PANEL',
    label: 'Display panel',
    x: 0.5,
    y: 0.15,
    face: 'FRONT',
    sortOrder: 60,
  },
  {
    category: 'AC',
    code: 'REMOTE_SENSOR',
    label: 'Remote sensor',
    x: 0.85,
    y: 0.15,
    face: 'FRONT',
    sortOrder: 70,
  },
  {
    category: 'AC',
    code: 'OUTDOOR_FAN',
    label: 'Outdoor fan',
    x: 0.5,
    y: 0.75,
    face: 'BACK',
    sortOrder: 80,
  },
  {
    category: 'AC',
    code: 'DRAIN_PIPE',
    label: 'Drain pipe',
    x: 0.5,
    y: 0.9,
    face: 'SIDE',
    sortOrder: 90,
  },
  // Refrigeration — new hotspots
  {
    category: 'REF',
    code: 'DISPLAY_PANEL',
    label: 'Display panel / controls',
    x: 0.5,
    y: 0.05,
    face: 'FRONT',
    sortOrder: 80,
  },
  {
    category: 'REF',
    code: 'CONDENSER_COILS',
    label: 'Condenser coils',
    x: 0.5,
    y: 0.5,
    face: 'BACK',
    sortOrder: 90,
  },
  {
    category: 'REF',
    code: 'ICE_MAKER',
    label: 'Ice maker unit (interior)',
    x: 0.3,
    y: 0.2,
    face: 'SIDE',
    sortOrder: 100,
  },
  // Generic / other appliances — no defaults existed at all
  {
    category: 'OTHER',
    code: 'CASING_FRONT',
    label: 'Casing / body — front',
    x: 0.5,
    y: 0.4,
    face: 'FRONT',
    sortOrder: 10,
  },
  {
    category: 'OTHER',
    code: 'CONTROL_PANEL',
    label: 'Control panel',
    x: 0.5,
    y: 0.15,
    face: 'FRONT',
    sortOrder: 20,
  },
  {
    category: 'OTHER',
    code: 'CASING_BACK',
    label: 'Casing / body — back',
    x: 0.5,
    y: 0.4,
    face: 'BACK',
    sortOrder: 30,
  },
  {
    category: 'OTHER',
    code: 'POWER_CORD',
    label: 'Power cord / inlet',
    x: 0.5,
    y: 0.9,
    face: 'BACK',
    sortOrder: 40,
  },
];
