import type { DeviceCategory } from '@/lib/types'

/**
 * Starter examples for the intake config admin page (symptom tree +
 * condition hotspots) — NOT seed data, and never written anywhere on their
 * own. They exist because building either list from a blank page is slow
 * and error-prone, especially for CE/AC/REF: prisma/seed.ts only ships a
 * symptom tree for HHP, so those device classes currently have NOTHING to
 * pick from at intake until an admin adds it by hand.
 *
 * The admin page filters these against what the company already has (by
 * code) and only offers what's missing — clicking one PREFILLS the create
 * dialog, it never saves directly, so the admin can still adjust wording,
 * pricing or position before it goes live.
 */

export interface SymptomSuggestion {
  code: string
  label: string
  /** Code of the intended PARENT suggestion — null for a root/category. */
  parentCode: string | null
}

export const SYMPTOM_SUGGESTIONS: Record<DeviceCategory, SymptomSuggestion[]> = {
  HHP: [
    { code: 'CAMERA', label: 'Camera', parentCode: null },
    { code: 'CAMERA.REAR_BLUR', label: 'Rear camera blurry / out of focus', parentCode: 'CAMERA' },
    { code: 'CAMERA.FRONT_DEAD', label: 'Front camera not working', parentCode: 'CAMERA' },
    { code: 'CAMERA.APP_CRASH', label: 'Camera app crashes on open', parentCode: 'CAMERA' },

    { code: 'AUDIO', label: 'Audio', parentCode: null },
    { code: 'AUDIO.SPEAKER_DISTORTED', label: 'Speaker distorted or crackling', parentCode: 'AUDIO' },
    { code: 'AUDIO.SPEAKER_SILENT', label: 'No sound from speaker', parentCode: 'AUDIO' },
    { code: 'AUDIO.MIC_NOT_PICKING_UP', label: 'Microphone not picking up voice', parentCode: 'AUDIO' },
    { code: 'AUDIO.EARPIECE_CRACKLE', label: 'Earpiece crackling on calls', parentCode: 'AUDIO' },

    { code: 'CONNECTIVITY', label: 'Connectivity', parentCode: null },
    { code: 'CONNECTIVITY.WIFI', label: "Won't connect to Wi-Fi", parentCode: 'CONNECTIVITY' },
    { code: 'CONNECTIVITY.BLUETOOTH', label: 'Bluetooth pairing fails', parentCode: 'CONNECTIVITY' },
    { code: 'CONNECTIVITY.NO_SIGNAL', label: 'No cellular signal / signal drops', parentCode: 'CONNECTIVITY' },
    { code: 'CONNECTIVITY.SIM_NOT_DETECTED', label: 'SIM card not detected', parentCode: 'CONNECTIVITY' },

    { code: 'BUTTONS', label: 'Buttons & sensors', parentCode: null },
    { code: 'BUTTONS.POWER_UNRESPONSIVE', label: 'Power button unresponsive', parentCode: 'BUTTONS' },
    { code: 'BUTTONS.VOLUME_STUCK', label: 'Volume button stuck / not registering', parentCode: 'BUTTONS' },
    { code: 'BUTTONS.FINGERPRINT_FAIL', label: 'Fingerprint sensor not recognising', parentCode: 'BUTTONS' },

    { code: 'THERMAL', label: 'Overheating', parentCode: null },
    { code: 'THERMAL.DURING_USE', label: 'Overheats during normal use', parentCode: 'THERMAL' },
    { code: 'THERMAL.WHILE_CHARGING', label: 'Overheats while charging', parentCode: 'THERMAL' },
  ],
  CE: [
    { code: 'PICTURE', label: 'Picture', parentCode: null },
    { code: 'PICTURE.NONE', label: 'No picture (black screen)', parentCode: 'PICTURE' },
    { code: 'PICTURE.NO_SOUND', label: 'Picture but no sound', parentCode: 'PICTURE' },
    { code: 'PICTURE.DISTORTED', label: 'Distorted or lined picture', parentCode: 'PICTURE' },
    { code: 'PICTURE.BACKLIGHT_FLICKER', label: 'Backlight flickering', parentCode: 'PICTURE' },
    { code: 'PICTURE.BURN_IN', label: 'Screen burn-in / ghosting', parentCode: 'PICTURE' },

    { code: 'SOUND', label: 'Sound', parentCode: null },
    { code: 'SOUND.NONE', label: 'No sound', parentCode: 'SOUND' },
    { code: 'SOUND.WITH_NO_PICTURE', label: 'Sound but no picture', parentCode: 'SOUND' },
    { code: 'SOUND.DISTORTED', label: 'Distorted or crackling audio', parentCode: 'SOUND' },

    { code: 'POWER', label: 'Power', parentCode: null },
    { code: 'POWER.NONE', label: "Won't power on at all", parentCode: 'POWER' },
    { code: 'POWER.SHUTS_OFF', label: 'Powers on then shuts off', parentCode: 'POWER' },
    { code: 'POWER.STANDBY_BLINK', label: 'Standby light blinking (error code)', parentCode: 'POWER' },

    { code: 'CONNECTIVITY', label: 'Connectivity', parentCode: null },
    { code: 'CONNECTIVITY.HDMI', label: 'HDMI port not detected', parentCode: 'CONNECTIVITY' },
    { code: 'CONNECTIVITY.SMART', label: 'Smart features / Wi-Fi not connecting', parentCode: 'CONNECTIVITY' },
    { code: 'CONNECTIVITY.REMOTE', label: 'Remote control unresponsive', parentCode: 'CONNECTIVITY' },
  ],
  AC: [
    { code: 'COOLING', label: 'Cooling', parentCode: null },
    { code: 'COOLING.NONE', label: 'Not cooling at all', parentCode: 'COOLING' },
    { code: 'COOLING.WEAK', label: 'Weak airflow', parentCode: 'COOLING' },
    { code: 'COOLING.WARM_AIR', label: 'Blows warm air', parentCode: 'COOLING' },
    { code: 'COOLING.STOPS', label: 'Cools briefly then stops', parentCode: 'COOLING' },

    { code: 'NOISE', label: 'Noise & vibration', parentCode: null },
    { code: 'NOISE.RATTLE', label: 'Unusual rattling noise', parentCode: 'NOISE' },
    { code: 'NOISE.VIBRATION', label: 'Excessive vibration', parentCode: 'NOISE' },

    { code: 'LEAKS', label: 'Leaks', parentCode: null },
    { code: 'LEAKS.INDOOR', label: 'Water leaking from indoor unit', parentCode: 'LEAKS' },
    { code: 'LEAKS.OUTDOOR', label: 'Water leaking from outdoor unit', parentCode: 'LEAKS' },

    { code: 'ELECTRICAL', label: 'Electrical', parentCode: null },
    { code: 'ELECTRICAL.NO_POWER', label: "Won't power on", parentCode: 'ELECTRICAL' },
    { code: 'ELECTRICAL.REMOTE_DEAD', label: 'Remote control unresponsive', parentCode: 'ELECTRICAL' },
    { code: 'ELECTRICAL.TRIPS_BREAKER', label: 'Trips the circuit breaker', parentCode: 'ELECTRICAL' },

    { code: 'ODOUR', label: 'Odour', parentCode: null },
    { code: 'ODOUR.BAD_SMELL', label: 'Bad smell when running', parentCode: 'ODOUR' },
    { code: 'ODOUR.MUSTY', label: 'Musty smell (suspected mould)', parentCode: 'ODOUR' },
  ],
  REF: [
    { code: 'COOLING', label: 'Cooling', parentCode: null },
    { code: 'COOLING.NOT_COOLING', label: 'Not cooling', parentCode: 'COOLING' },
    { code: 'COOLING.FREEZER_WARM', label: 'Freezer not freezing', parentCode: 'COOLING' },
    { code: 'COOLING.TOO_COLD', label: 'Fridge section too cold', parentCode: 'COOLING' },
    { code: 'COOLING.UNEVEN', label: 'Uneven cooling between shelves', parentCode: 'COOLING' },

    { code: 'NOISE', label: 'Noise', parentCode: null },
    { code: 'NOISE.COMPRESSOR_HUM', label: 'Compressor humming loudly', parentCode: 'NOISE' },
    { code: 'NOISE.CLICKING', label: 'Clicking noise', parentCode: 'NOISE' },
    { code: 'NOISE.BUZZING', label: 'Buzzing noise', parentCode: 'NOISE' },

    { code: 'LEAKS', label: 'Leaks', parentCode: null },
    { code: 'LEAKS.INSIDE', label: 'Water pooling inside', parentCode: 'LEAKS' },
    { code: 'LEAKS.FLOOR', label: 'Water leaking onto the floor', parentCode: 'LEAKS' },

    { code: 'ICE_FROST', label: 'Ice & frost', parentCode: null },
    { code: 'ICE_FROST.EXCESS_FROST', label: 'Excessive frost buildup', parentCode: 'ICE_FROST' },
    { code: 'ICE_FROST.MAKER_DEAD', label: 'Ice maker not working', parentCode: 'ICE_FROST' },
    { code: 'ICE_FROST.MAKER_LEAK', label: 'Ice maker leaking', parentCode: 'ICE_FROST' },

    { code: 'DOORS', label: 'Doors & seals', parentCode: null },
    { code: 'DOORS.SEAL_FAIL', label: "Door seal doesn't hold (gasket)", parentCode: 'DOORS' },
    { code: 'DOORS.WONT_CLOSE', label: "Door won't close properly", parentCode: 'DOORS' },

    { code: 'ELECTRICAL', label: 'Electrical', parentCode: null },
    { code: 'ELECTRICAL.NO_POWER', label: "Won't power on", parentCode: 'ELECTRICAL' },
    { code: 'ELECTRICAL.LIGHT_OUT', label: 'Interior light not working', parentCode: 'ELECTRICAL' },
  ],
  OTHER: [
    { code: 'GENERAL', label: 'General', parentCode: null },
    { code: 'GENERAL.NO_POWER', label: "Won't power on", parentCode: 'GENERAL' },
    { code: 'GENERAL.INTERMITTENT', label: 'Works intermittently', parentCode: 'GENERAL' },
    { code: 'GENERAL.PHYSICAL_DAMAGE', label: 'Visible physical damage', parentCode: 'GENERAL' },
    { code: 'GENERAL.NOISE', label: 'Unusual noise', parentCode: 'GENERAL' },
    { code: 'GENERAL.OVERHEATING', label: 'Overheating', parentCode: 'GENERAL' },
    { code: 'GENERAL.ERROR_CODE', label: 'Error code displayed', parentCode: 'GENERAL' },
  ],
}

export interface ZoneSuggestion {
  code: string
  label: string
  x: number
  y: number
  face: 'FRONT' | 'BACK' | 'SIDE'
}

export const ZONE_SUGGESTIONS: Record<DeviceCategory, ZoneSuggestion[]> = {
  HHP: [
    { code: 'HOME_AREA', label: 'Home button / fingerprint area', x: 0.5, y: 0.93, face: 'FRONT' },
    { code: 'CAM_REAR', label: 'Rear camera lens', x: 0.3, y: 0.08, face: 'BACK' },
    { code: 'FINGERPRINT_BACK', label: 'Fingerprint sensor (back)', x: 0.5, y: 0.3, face: 'BACK' },
    { code: 'LOGO_AREA', label: 'Logo / branding area', x: 0.5, y: 0.5, face: 'BACK' },
    { code: 'BATTERY_COVER', label: 'Battery cover', x: 0.5, y: 0.85, face: 'BACK' },
    { code: 'POWER_BTN', label: 'Power button', x: 0.95, y: 0.35, face: 'SIDE' },
    { code: 'VOLUME_BTN', label: 'Volume buttons', x: 0.05, y: 0.3, face: 'SIDE' },
    { code: 'CHARGE_PORT', label: 'Charging port', x: 0.5, y: 0.97, face: 'SIDE' },
    { code: 'HEADPHONE_JACK', label: 'Headphone jack', x: 0.2, y: 0.97, face: 'SIDE' },
    { code: 'SIM_TRAY', label: 'SIM tray', x: 0.95, y: 0.15, face: 'SIDE' },
    { code: 'SPEAKER_GRILLE', label: 'Speaker grille', x: 0.75, y: 0.97, face: 'SIDE' },
  ],
  CE: [
    { code: 'SCREEN_CENTRE', label: 'Screen — centre', x: 0.5, y: 0.4, face: 'FRONT' },
    { code: 'SCREEN_TL', label: 'Screen — top-left corner', x: 0.15, y: 0.1, face: 'FRONT' },
    { code: 'SCREEN_TR', label: 'Screen — top-right corner', x: 0.85, y: 0.1, face: 'FRONT' },
    { code: 'SCREEN_BL', label: 'Screen — bottom-left corner', x: 0.15, y: 0.65, face: 'FRONT' },
    { code: 'SCREEN_BR', label: 'Screen — bottom-right corner', x: 0.85, y: 0.65, face: 'FRONT' },
    { code: 'BEZEL', label: 'Bezel / frame', x: 0.5, y: 0.75, face: 'FRONT' },
    { code: 'STAND_BASE', label: 'Stand / base', x: 0.5, y: 0.95, face: 'FRONT' },
    { code: 'HDMI_PORTS', label: 'HDMI ports', x: 0.3, y: 0.5, face: 'BACK' },
    { code: 'POWER_INLET', label: 'Power inlet', x: 0.7, y: 0.5, face: 'BACK' },
    { code: 'SPEAKER_GRILLE', label: 'Speaker grille', x: 0.5, y: 0.8, face: 'BACK' },
    { code: 'SIDE_CONTROLS', label: 'Side buttons / controls', x: 0.9, y: 0.3, face: 'SIDE' },
    { code: 'USB_PORT', label: 'USB port', x: 0.5, y: 0.4, face: 'SIDE' },
  ],
  AC: [
    { code: 'FRONT_PANEL', label: 'Front panel / louvers', x: 0.5, y: 0.35, face: 'FRONT' },
    { code: 'DISPLAY_PANEL', label: 'Display panel', x: 0.5, y: 0.15, face: 'FRONT' },
    { code: 'FILTER_ACCESS', label: 'Filter access', x: 0.5, y: 0.5, face: 'FRONT' },
    { code: 'REMOTE_SENSOR', label: 'Remote sensor', x: 0.85, y: 0.15, face: 'FRONT' },
    { code: 'OUTDOOR_BODY', label: 'Outdoor unit body', x: 0.5, y: 0.4, face: 'BACK' },
    { code: 'OUTDOOR_FAN', label: 'Outdoor fan', x: 0.5, y: 0.7, face: 'BACK' },
    { code: 'PIPES_INSULATION', label: 'Pipes / insulation', x: 0.2, y: 0.5, face: 'SIDE' },
    { code: 'DRAIN_PIPE', label: 'Drain pipe', x: 0.5, y: 0.9, face: 'SIDE' },
  ],
  REF: [
    { code: 'DOOR_FRIDGE', label: 'Door — fridge section', x: 0.5, y: 0.55, face: 'FRONT' },
    { code: 'DOOR_FREEZER', label: 'Door — freezer section', x: 0.5, y: 0.15, face: 'FRONT' },
    { code: 'DOOR_SEAL', label: 'Door seal / gasket', x: 0.15, y: 0.4, face: 'FRONT' },
    { code: 'DISPLAY_PANEL', label: 'Display panel / controls', x: 0.5, y: 0.05, face: 'FRONT' },
    { code: 'HANDLE', label: 'Handle', x: 0.85, y: 0.3, face: 'FRONT' },
    { code: 'COMPRESSOR', label: 'Compressor', x: 0.5, y: 0.85, face: 'BACK' },
    { code: 'CONDENSER_COILS', label: 'Condenser coils', x: 0.5, y: 0.5, face: 'BACK' },
    { code: 'ICE_MAKER', label: 'Ice maker unit (interior)', x: 0.3, y: 0.2, face: 'SIDE' },
    { code: 'SHELVES_BINS', label: 'Shelves / bins', x: 0.5, y: 0.5, face: 'SIDE' },
  ],
  OTHER: [
    { code: 'CASING_FRONT', label: 'Casing / body — front', x: 0.5, y: 0.4, face: 'FRONT' },
    { code: 'CONTROL_PANEL', label: 'Control panel', x: 0.5, y: 0.15, face: 'FRONT' },
    { code: 'CASING_BACK', label: 'Casing / body — back', x: 0.5, y: 0.4, face: 'BACK' },
    { code: 'POWER_CORD', label: 'Power cord / inlet', x: 0.5, y: 0.9, face: 'BACK' },
  ],
}
