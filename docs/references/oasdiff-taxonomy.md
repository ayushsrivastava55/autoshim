# oasdiff breaking-change taxonomy (extracted 2026-09-01, for Task 6 differ)
# To be committed to docs/references/ with the Task 6 PR. Source: oasdiff/oasdiff docs.

Totals: 273 breaking (ERR), 17 warning, 282 info across 572 detectable change types.

## Breaking (ERR) by category
- PATHS/OPERATIONS: endpoint or operation removed (worse without prior deprecation/sunset); stability decreased; sunset shortened/removed while deprecated; insufficient deprecation notice.
- REQUEST PARAMS: required path/query/header param added; param became required or non-nullable; type changed/narrowed; enum value removed; max/min/maxLength/minItems/pattern tightened or added; param became disallowed; path params always breaking on change (required by definition).
- REQUEST BODY: required field added; field became required/non-nullable; type changed/narrowed; enum value removed; allOf/anyOf/oneOf structure changed; constraints tightened; const added/changed; conditional requirement added; body became required; media type removed; schema ADDED to previously-untyped request media type.
- RESPONSE: property became nullable or optional (was required); type changed; ENUM VALUE ADDED (new unexpected value); const removed/changed; media type removed; success status removed; schema REMOVED from response media type.
- SECURITY: endpoint/global security requirement or scope removed; scope added to requirement.
- HEADERS: required response header removed; type changed; became nullable.

## Contravariance rules (the subtle ones)
1. Request schema set within media type = BREAKING; unset = info. Response REVERSED.
2. Request type narrowed = BREAKING; response type narrowed = info.
3. Request became non-nullable = BREAKING / became nullable = info. Response REVERSED.
4. Enum: removed from request = BREAKING; added to response = BREAKING.
5. Constraint tightening breaks BOTH directions.

## Warning-level (impact unknowable statically)
- pattern modified (param/request prop/response prop); request parameter or property removed ENTIRELY (oasdiff says WARN, unknown impact — note: OUR product treats removal as breaking because we see consumer code); response media type renamed; body wrapped in oneOf with original preserved; 3.1 prefixItems changes.

## Info-level (non-breaking)
- endpoint/param/property added (optional); optional body added; deprecation marked; constraint loosened; default changed (!); media type added; optional header removed; response type narrowed; nullable loosened per direction rules.

## Implications for Autoshim's differ (Task 6)
- Our SpecDiff kinds {added_required, removed, renamed, type_change, enum_removed} map onto the highest-value ERR rules; classification must respect request/response direction for enum + nullable + narrowing.
- v1 scope decision needed: direction-aware enum/nullable rules vs flat rules; constraint-tightening (max/min/pattern) detection as a v1.1 follow-up.
- oasdiff marks bare param removal WARN; we upgrade to breaking because impact scan confirms actual usage in consumer code — our advantage over spec-only tools.
