import { nanoid } from "nanoid";

// 32 URL-safe chars → ~190 bits of CSPRNG entropy. Unguessable at any
// realistic campaign scale. Used for public RSVP links.
export const newRsvpToken = () => nanoid(32);
