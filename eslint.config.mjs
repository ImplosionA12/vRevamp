import globals from "globals";

// All content scripts listed in manifest.json share one isolated world, so
// top-level declarations in one file are visible in the others (the offline
// page scripts in js/offline/ share scope the same way via offline.html).
// Symbols defined in one file and used from another are declared here.
const sharedNames = [
  // js/store
  "saveData",
  "getData",
  "saveMarksPage",
  "getMarksPage",
  "saveAttendancePage",
  "getAttendancePage",
  "saveExamSchedulePage",
  "getExamSchedulePage",
  "saveTimeTable",
  "getTimeTable",
  // js/utils
  "chooseCurrentSemester",
  "semesterFallbackOrder",
  "filterRepeated",
  "filterRepeatedColumns",
  // js/captcha
  "bitmaps",
  "fill_captcha",
  // js/modules/dom-to-image.js
  "domtoimage",
  // js/timetable
  "extract_header",
  "extract_tbody_data",
  "extract_tr_data",
  "createTableHead",
  "createTr",
  "_create_td_element",
  "create_download_link",
  "getPlaceholder",
  "getBlockText",
  "getCourseCode",
  "addBlocks",
  "change_time_table",
  // js/offline
  "createMenu",
  "createTable",
  "displayTableData",
  "insertTable",
];

const sharedGlobals = Object.fromEntries(
  sharedNames.map((name) => [name, "readonly"])
);

const sharedRules = {
  "no-undef": "error",
  "no-unused-vars": [
    "warn",
    {
      args: "none",
      caughtErrors: "none",
      varsIgnorePattern: `^(${sharedNames.join("|")})$`,
    },
  ],
  // builtinGlobals off so defining a shared symbol in its home file is fine
  "no-redeclare": ["error", { builtinGlobals: false }],
};

export default [
  {
    ignores: ["js/modules/**", "js/captcha/bitmaps.js", "node_modules/**"],
  },
  {
    files: ["js/**/*.js", "service_worker/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...sharedGlobals,
      },
    },
    rules: sharedRules,
  },
  {
    // Runs in the VTOP page context (injected via <script>), where the
    // page's jQuery and helpers exist.
    files: ["js/outing/store.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.jquery,
        getnumber: "readonly",
      },
    },
    rules: sharedRules,
  },
];
