{ self }:
{
  pkgs,
  source,
  projectDir ? ".",
  dependencyOverrides ? { },
  extraRoots ? { },
}:

let
  lib = pkgs.lib;
  storePrefix = "${builtins.storeDir}/";
  derivationSourceError = "skillful mkProject source must be a flake input or plain store path, not a derivation or derivation output";
  sourceValue =
    if lib.isDerivation source
    then throw derivationSourceError
    else if builtins.elem (builtins.typeOf source) [ "path" "string" ]
    then source
    else if source ? outPath
    then source.outPath
    else throw "skillful mkProject source must already be a flake input or store path; pass self and projectDir, not a relative working-tree path.";
  sourceString = toString sourceValue;
  sourceContext = builtins.attrValues (builtins.getContext sourceString);
  hasDerivationContext = lib.any (entry: entry ? outputs || entry ? allOutputs) sourceContext;
  storeBacked = lib.hasPrefix storePrefix sourceString;
  checkedProjectDir =
    if builtins.typeOf projectDir != "string"
      || projectDir == ""
      || lib.hasPrefix "/" projectDir
      || lib.hasInfix "\\" projectDir
      || (projectDir != "." && builtins.any (segment: builtins.elem segment [ "" "." ".." ]) (lib.splitString "/" projectDir))
    then throw "skillful mkProject projectDir must be . or a normalized relative path such as agent"
    else projectDir;
in
if hasDerivationContext
then throw derivationSourceError
else if !storeBacked
then throw "skillful mkProject source must already be a flake input or store path; pass self and projectDir, not a relative working-tree path."
else
let
  engineCli = self.packages.${pkgs.stdenv.hostPlatform.system}.skillful;
  storePath = name: value:
    if builtins.typeOf value == "path"
    then builtins.path { path = value; name = "skillful-${name}"; }
    else value;
  projectSource = sourceValue;
  projectRoot = if checkedProjectDir == "." then projectSource else projectSource + "/${checkedProjectDir}";
  checkedProjectRoot =
    if !(builtins.pathExists (projectRoot + "/skill.mod"))
    then throw "skillful mkProject projectDir must contain skill.mod"
    else projectRoot;
  harnessDir = ../harnesses;
  harnessFiles = builtins.attrNames (lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".json" name) (builtins.readDir harnessDir));
  facts = builtins.listToAttrs (map (file:
    let value = builtins.fromJSON (builtins.readFile (harnessDir + "/${file}"));
    in {
      name = value.name;
      inherit value;
    }) harnessFiles);
  knownHarnesses = builtins.attrNames facts;
  setupDeclarations = (import ./parseMod.nix { inherit lib facts; }) (checkedProjectRoot + "/skill.mod");
  setupNames = builtins.attrNames setupDeclarations;
  pathConflict = left: right:
    left == "." || right == "." || left == right
    || lib.hasPrefix "${left}/" right
    || lib.hasPrefix "${right}/" left;
  extraRootEntries = kind: field:
    map (entry:
      if !(entry ? origin) || entry.origin == "" || !(entry ? source)
      then throw "skillful extra ${kind} roots require non-empty origin and source"
      else entry) (extraRoots.${field} or [ ]);
  checkedExtraRoots = {
    skills = extraRootEntries "skill" "skills";
    commands = extraRootEntries "command" "commands";
  };
  lockPath = checkedProjectRoot + "/skill.lock";
  lockEntries =
    if !(builtins.pathExists lockPath)
    then [ ]
    else
      let
        text = builtins.readFile lockPath;
        rawLines = lib.splitString "\n" text;
        lines = if rawLines != [ ] && lib.last rawLines == "" then lib.init rawLines else rawLines;
        parse = index: line:
          let fields = lib.splitString " " line;
          in if line == "" || builtins.length fields != 4
          then throw "skill.lock:${toString (index + 1)} must contain exactly name ref rev narHash"
          else {
            name = builtins.elemAt fields 0;
            ref = builtins.elemAt fields 1;
            rev = builtins.elemAt fields 2;
            narHash = builtins.elemAt fields 3;
          };
        entries = lib.imap0 parse lines;
        names = map (entry: entry.name) entries;
      in
      if lib.hasInfix "<<<<<<<" text || lib.hasInfix "=======" text || lib.hasInfix ">>>>>>>" text
      then throw "skill.lock contains a merge conflict; resolve it before evaluation"
      else if names != lib.sort builtins.lessThan names || builtins.length names != builtins.length (lib.unique names)
      then throw "skill.lock dependency names must be unique and sorted"
      else if builtins.any (entry: builtins.match "[a-z0-9][a-z0-9._-]*" entry.name == null
        || builtins.match "[0-9a-f]{40,64}" entry.rev == null
        || builtins.match "sha256-[A-Za-z0-9+/]{43}=" entry.narHash == null) entries
      then throw "skill.lock contains an invalid name, revision, or SRI sha256"
      else entries;
  fetchLocked = entry:
    let
      github = builtins.match "github:([^/]+)/([^/@]+)(/([^@]+))?@(.+)" entry.ref;
      generic = builtins.match "git:(.*)@([^@#]+)(#(.*))?" entry.ref;
      fetched =
        if github != null
        then builtins.fetchTree {
          type = "github";
          owner = builtins.elemAt github 0;
          repo = builtins.elemAt github 1;
          inherit (entry) rev narHash;
        }
        else if generic != null
        then builtins.fetchTree {
          type = "git";
          url = builtins.elemAt generic 0;
          inherit (entry) rev narHash;
        }
        else throw "unsupported locked dependency ref ${entry.ref}";
      subdir = if github != null then builtins.elemAt github 3 else if generic != null then builtins.elemAt generic 3 else null;
      root = fetched.outPath;
    in if subdir == null || subdir == "" then root else root + "/${subdir}";
  lockedOverrides = builtins.listToAttrs (map (entry: {
    inherit (entry) name;
    value = if builtins.hasAttr entry.name dependencyOverrides then dependencyOverrides.${entry.name} else fetchLocked entry;
  }) lockEntries);
  resolvedOverrides = builtins.mapAttrs (name: path: storePath "dependency-${name}" path) (lockedOverrides // dependencyOverrides);
  overrideArgs = lib.concatLists (lib.mapAttrsToList (name: path: [ "--override" "${name}=${toString path}" ]) resolvedOverrides);
  normalizedExtraRoots = {
    skills = map (entry: entry // { source = storePath "extra-skill-${entry.origin}" entry.source; }) checkedExtraRoots.skills;
    commands = map (entry: entry // { source = storePath "extra-command-${entry.origin}" entry.source; }) checkedExtraRoots.commands;
  };
  extraArgs = lib.concatMap (entry: [ "--extra-skill-root" "${entry.origin}=${toString entry.source}" ]) normalizedExtraRoots.skills
    ++ lib.concatMap (entry: [ "--extra-command-root" "${entry.origin}=${toString entry.source}" ]) normalizedExtraRoots.commands;
  projectArgs = [ "--project" (toString checkedProjectRoot) "--source-root" (toString projectSource) ] ++ overrideArgs ++ extraArgs;
  escapedProjectArgs = lib.escapeShellArgs projectArgs;
  renderTree = derivationName: renderArgs: pkgs.runCommand derivationName {
    nativeBuildInputs = [ engineCli ];
    projectSource = toString projectSource;
    projectRoot = toString checkedProjectRoot;
    dependencySources = builtins.attrValues resolvedOverrides;
    extraRootSources = map (entry: entry.source) (normalizedExtraRoots.skills ++ normalizedExtraRoots.commands);
  } ''
    export HOME="$TMPDIR/home"
    export XDG_CACHE_HOME="$TMPDIR/cache"
    export XDG_STATE_HOME="$TMPDIR/state"
    mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
    skillful render ${lib.escapeShellArgs renderArgs} --project "$projectRoot" --source-root "$projectSource" --out "$TMPDIR/rendered" ${lib.escapeShellArgs (overrideArgs ++ extraArgs)}
    cp -r "$TMPDIR/rendered" "$out"
  '';
  rendered = renderTree "skillful-project-render" [ ];
  forHarness = name:
    if !(builtins.hasAttr name facts)
    then throw "unknown skillful harness ${name}; known: ${lib.concatStringsSep ", " knownHarnesses}"
    else
      let harnessRendered = renderTree "skillful-${name}-render" [ "--harness" name ];
      in {
        paths = facts.${name}.installPaths.home;
        skills = "${harnessRendered}/${name}/skills";
        commands = "${harnessRendered}/${name}/commands";
        rules = "${harnessRendered}/${name}/rules.md";
      };
  forSetup = name:
    if !(builtins.hasAttr name setupDeclarations)
    then throw "unknown skillful setup ${name}; known: ${lib.concatStringsSep ", " setupNames}"
    else
      let
        setup = setupDeclarations.${name};
        resolvedHarnesses = map (harness:
          if facts.${harness.name}.commandMerge == "skill" && harness.paths ? commands
          then throw "skillful setup ${name} harness ${harness.name} does not support a commands path"
          else harness // {
            paths = facts.${harness.name}.installPaths.${setup.root} // harness.paths;
          }
        ) setup.harnesses;
        setupRendered = renderTree "skillful-setup-${name}-render" [ name ];
        entries = lib.concatMap (harness: lib.mapAttrsToList (category: destination: {
          inherit category destination;
          harness = harness.name;
          recursive = category != "rules";
          source = "${setupRendered}/${harness.name}/${if category == "rules" then "rules.md" else category}";
        }) harness.paths) resolvedHarnesses;
        destinations = map (entry: entry.destination) entries;
        duplicateDestinations = builtins.length destinations != builtins.length (lib.unique destinations);
        overlappingDestinations = builtins.any (left: builtins.any (right:
          left != right && pathConflict left right
        ) destinations) destinations;
        files = builtins.listToAttrs (map (entry: {
          name = entry.destination;
          value = builtins.removeAttrs entry [ "destination" ];
        }) entries);
        harnesses = builtins.listToAttrs (map (harness: {
          name = harness.name;
          value = {
            paths = harness.paths;
            skills = "${setupRendered}/${harness.name}/skills";
            commands = "${setupRendered}/${harness.name}/commands";
            rules = "${setupRendered}/${harness.name}/rules.md";
          };
        }) resolvedHarnesses);
      in if duplicateDestinations
      then throw "skillful setup ${name} has duplicate destinations"
      else if overlappingDestinations
      then throw "skillful setup ${name} has overlapping destinations"
      else {
        inherit name files harnesses;
        root = setup.root;
        selection = setup.selection;
        rendered = setupRendered;
      };

  checks = {
    render = rendered;
    strict = pkgs.runCommand "skillful-project-strict-check" { nativeBuildInputs = [ engineCli ]; } ''
      skillful check --strict --format json ${escapedProjectArgs} > "$out"
    '';
  };
in
builtins.seq checkedProjectRoot {
  inherit forHarness forSetup checks rendered;
}
