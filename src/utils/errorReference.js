// A short code like "E-7F3A9C" shown to the person who hit an error and
// written in the matching log line, so staff can find what went wrong.

import { randomBytes } from "node:crypto";

export const errorReference = () => `E-${randomBytes(3).toString("hex").toUpperCase()}`;
