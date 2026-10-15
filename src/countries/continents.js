// Which continent each country is listed under, for the continent buttons on
// the /country-help guide. Keys are ISO 3166-1 alpha-2 codes (see countries.js).
//
// The Americas are split in two so neither list is too long. Central America
// and the Caribbean count as North America. Remote Antarctic territories are
// listed with the nearest continent, since there is no Antarctica button.

export const Continent = Object.freeze({
  AFRICA: "africa",
  ASIA: "asia",
  EUROPE: "europe",
  NORTH_AMERICA: "north-america",
  SOUTH_AMERICA: "south-america",
  OCEANIA: "oceania",
});

// The order the buttons appear in.
export const CONTINENTS = Object.values(Continent);

const CODES = {
  [Continent.AFRICA]:
    "DZ AO BJ BW IO BF BI CV CM CF TD KM CD CG CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
  [Continent.ASIA]:
    "AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE",
  [Continent.EUROPE]:
    "AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB VA",
  [Continent.NORTH_AMERICA]:
    "AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI",
  [Continent.SOUTH_AMERICA]: "AR BO BV BR CL CO EC FK GF GY PY PE GS SR UY VE",
  [Continent.OCEANIA]:
    "AS AQ AU CX CC CK FJ PF TF GU HM KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV UM VU WF",
};

const continentByCode = new Map(
  Object.entries(CODES).flatMap(([continent, codes]) => codes.split(" ").map((code) => [code, continent])),
);

// The continent a country is listed under, or undefined if it has none.
export function continentOf(code) {
  return continentByCode.get(code);
}
