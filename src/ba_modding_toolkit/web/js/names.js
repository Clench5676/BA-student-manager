// The first saved student alias is the display name; all saved aliases remain searchable and editable.
export const customAliases = (family) => (Array.isArray(family?.custom) ? family.custom.filter((a) => typeof a === "string" && a) : []);
export const studentName = (family, original) => customAliases(family)[0] || original;

// A mod's label may already be its alias. Its core and file name still identify the original game resource.
export const modOriginalName = (mod) => mod?.core || mod?.file?.split(/[\\/]/).pop() || (mod?.label !== mod?.alias ? mod?.label : "") || "";
