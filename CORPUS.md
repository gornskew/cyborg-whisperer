# The Lisply corpus: how a project provides a `lisply_search` index

Copyright © 2026 Gornskew Enterprises.  AGPL-3.0-or-later; see COPYING.txt.

`lisply_search` is the one Lisply tool that answers from a prebuilt
index rather than from the live image (BACKEND-REQS.md, "Design
Guidance").  This document is the single source of truth for that
index: what a **corpus file** is, how a **project** builds and ships
one, and how a **console** that serves `lisply_search` finds and
merges the corpora aboard.  The reference indexer that produces the
format lives beside this file, `scripts/lisply-index.js`.

The principle (2026-09-14): **content lives with each project; the
format lives with the protocol that promises it.**  Gendl's corpus is
Gendl's to build and carry, in the image that carries Gendl, so it
describes the Gendl actually aboard.  A console never fetches another
project's source; it reads the index files the deployment puts in
front of it.  Only the index travels: it is self-contained -- snippets
pre-extracted, terms pre-computed -- and needs no source at search
time.

## 1. The corpus file

One corpus is one file, `<name>.sexp`: a UTF-8 s-expression, a
property list with keyword keys.  Format version 4.

```lisp
(:version 4
 :generated-at "2026-09-14T15:02:39Z"     ; UTC
 :corpus "gendl"                          ; the corpus name (a source name)
 :distribution :public                    ; or :internal, see section 4
 :generator "lisply-index 1"              ; what wrote it
 :checksum "936-10485760"                 ; "<file count>-<total source bytes>"
 :config (...)                            ; the effective configuration, section 2
 :files [FILE ...])                       ; a vector
```

Each FILE:

```lisp
(:source :gendl                 ; keyword: the corpus name
 :path "/corpus/geom-base/source/box.lisp"   ; absolute where it was indexed
 :repo "gendl"                  ; a short repository name, reported in hits
 :repo-root "/corpus"           ; hits report :path relative to this
 :language :lisp                ; :lisp :gendl :gdl :markdown or nil
 :mtime "2026-09-10T20:27:11Z"
 :snippets [SNIPPET ...])       ; nil for a file too large to index
```

Each SNIPPET is one chunk of the file:

```lisp
(:start-line 46 :end-line 63    ; 0-based, inclusive
 :snippet "(defun register-cad-export! ..."   ; the text, at most :max-chars
 :preview "(defun register-cad-export! (name &key ..."   ; first non-blank line
 :section "Stateless CAD Export"  ; nearest heading above (Markdown/Org), or nil
 :language :lisp
 :terms ["defun" "register" "cad" "export" ...])   ; unique, lowercase
```

Rules that keep every producer's output interchangeable:

- **Chunks begin at structure.**  In Lisp-family files (`.lisp .lsp
  .cl .gdl .gendl .asd .el`) a chunk may begin only at a top-level form
  (a `(` in column 0); in Markdown at a heading line (`#`), in Org at a
  heading (`*`).  Adjacent small segments are packed up to the budget
  (default 24 lines, 1200 characters); a segment over budget is cut
  into fixed windows of that size; a leading comment block of 8 lines
  or more (a licence header) stands alone.  Files with no recognised
  structure are cut into fixed windows.  No line of a file is left out.
- **Every snippet respects the character budget** whatever its line
  count: a single line longer than the budget is stored truncated.
- **Terms** are the lowercase runs of `[a-z0-9_]` in the snippet, of
  two characters or more, unique, in order of first appearance.
- **Paths**: `:path` is absolute in the filesystem where the index was
  built; consumers show it relative to `:repo-root`.  Slashes forward.
- **Encoding**: the file is UTF-8, strings escaped only for `"` and
  `\`; a consumer decodes as UTF-8 without guessing.
- **Names**: `:corpus` and every FILE's `:source` are the same name, a
  short lowercase slug (`gendl`, `readymax`, `demos`).  A console keys
  overrides on it (section 5).

## 2. The project's declaration: `lisply-corpus.sexp`

A project that provides a corpus keeps one file at its repository
root.  The indexer reads it when given `--root <repo>`, and every key
is optional but `:name`:

```lisp
(:lisply-corpus
 (:name "gendl"
  :distribution :public          ; default :public
  :subdirs ("geom-base" "gwl")   ; index only these directories (default: all)
  :ignore-dirs (".git" "node_modules" "dist" "build" "vendor" "target" ".cache" "logs" "tmp" "docker")
  :exclude-paths ("**/*.min.js" "**/*.min.css" "**/3rdpty/**" "**/static/plugins/**")
  :extensions (".lisp" ".lsp" ".cl" ".gdl" ".gendl" ".asd" ".isc"
               ".md" ".markdown" ".org" ".txt" ".rst"
               ".el" ".js" ".ts" ".json" ".yml" ".yaml" ".html" ".css")
  :max-lines 24
  :max-chars 1200))
```

The values shown are the defaults.  `:exclude-paths` are globs matched
against the absolute path, case-insensitively, `*` crossing
directories (`**` is written for the reader); `:ignore-dirs` are
directory names skipped wherever they occur.  Names beginning with a
dot, editor backups (`name~`) and autosaves (`#name#`) are never
corpus.  Files over 1 MiB are listed but not chunked.

## 3. Building: the reference indexer

```bash
node scripts/lisply-index.js --root /path/to/checkout --out lisply-corpus/gendl.sexp
```

Flags override the declaration: `--name`, `--distribution`,
`--subdirs a,b`, `--repo`, `--repo-root`, `--max-lines`, `--max-chars`,
`--config FILE`.  The tool exits non-zero when nothing was indexed, so
a CI step cannot go green with an empty corpus.  It needs only Node;
every Readymax image carries it as `lisply-index` on the path, so a
project's CI can also run it from that image:

```bash
docker run --rm --entrypoint lisply-index --user "$(id -u):$(id -g)" \
  -v "$PWD:/corpus:ro" -v "$PWD/out:/out" gornskew/readymax:devo-lite \
  --root /corpus --out /out/gendl.sexp
```

(`--entrypoint` matters: the image's own entrypoint starts the console
and ignores the command.  `--user` matters on a CI runner: the image's
user is uid 1000, and the output directory is yours.  Images from
before the evening of 2026-09-14 keep the script under the image
user's 0700 home only, so `--user` cannot reach it there; with those,
drop `--user` and `chmod 777` the output directory for the run
instead.)

Other producers are welcome (the Readymax console has an Emacs Lisp
one for its own corpus); what makes them conforming is the file they
write, section 1.

## 4. Shipping: the image label

A project that ships an image puts its corpus file in the image and
names it with the OCI label **`lisply.corpus`**: a space-separated
list of absolute paths inside the image.

```dockerfile
COPY lisply-corpus/gendl.sexp /opt/gendl/lisply-corpus/gendl.sexp
LABEL lisply.corpus="/opt/gendl/lisply-corpus/gendl.sexp"
```

The label is authoritative; the path is the project's choice
(`/opt/<project>/lisply-corpus/<name>.sexp` is the convention).  A
deployment tool reads the label off every image it runs and copies the
files out (`docker create` + `docker cp`), never starting the container
and never needing the source.

`:distribution :internal` marks a corpus that must never be baked into
a publicly distributed image: a console building its own baked index
skips internal sources; an internal corpus reaches a console only as a
file the deployment mounts.

## 5. Consuming: the corpora directory and the merge

A console that serves `lisply_search` loads:

1. its own baked index (its own content, plus whatever public fallback
   it chose to bake, such as a Gendl corpus for standalone use), and
2. every `*.sexp` in the directory named by **`LISPLY_SEARCH_CORPORA`**
   (default `/lisply/corpora`), which the deployment fills from the
   images aboard (section 4) and from corpora it builds itself from
   mounted source.

The merge rule: **a corpus in the directory replaces a same-named
source in the baked index** -- the Gendl aboard outranks the Gendl the
console was built with.  Corpora in the directory do not override each
other.  The response's `sources` lists what is actually loaded, and
`corpora` names each loaded file with its `:generated-at`, so a client
can see what it is searching.  The console reloads when any file's
modification time changes.

## 6. The search response

The `lisply_search` tool's arguments and response are the backend's
(`POST /lisply/lisply-search`); the Readymax console's
`dot-files/emacs.d/sideloaded/lisply-backend/CLAUDE.md` documents the
current parameters (`query`, `k`, `sources`, `path_filters`,
`match_mode`, `max_snippet_tokens`, ...) and the hit shape (`source`,
`repo`, `path`, `start_line`, `end_line`, `match_line`, `snippet`,
`preview`).  Two fields matter to the corpus contract: hits carry the
corpus name in `source`, and `path` is relative to the corpus file's
`:repo-root`.

## Versioning

The corpus file's `:version` is the format version; consumers accept
the versions they know and refuse others with a clear message.  A
change to section 1 that an old consumer cannot read is a new version
number; adding an optional key is not.
