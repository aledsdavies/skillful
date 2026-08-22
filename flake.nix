{
  description = "Author agent skills once, render them per harness";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkProject = import ./nix/mkProject.nix { inherit self; };
      revision = if self ? rev then builtins.substring 0 12 self.rev else self.dirtyShortRev or null;
      skillfulPackage = pkgs: import ./nix/package.nix {
        inherit pkgs revision;
        src = self;
        sourceHash = self.narHash;
      };
    in
    {
      lib = { inherit mkProject; };

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          skillful = skillfulPackage pkgs;
        in
        {
          inherit skillful;
          default = skillful;
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          skillful = skillfulPackage pkgs;
          bunDeps = import ./nix/bun-deps.nix { inherit pkgs; };
          packageVersion = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          versionLine = if revision == null then "skillful ${packageVersion} (source ${self.narHash})" else "skillful ${packageVersion} (rev ${revision}; source ${self.narHash})";
          fixture = mkProject {
            inherit pkgs;
            source = self;
            projectDir = "templates/basic";
          };
          setupFixture = mkProject {
            inherit pkgs;
            source = self;
            projectDir = "tests/fixtures/setup-project";
          };
          derivationProject = pkgs.runCommand "skillful-derivation-project" { } ''
            cp -r ${./templates/basic} "$out"
          '';
          invalidDerivationOutputSource = builtins.tryEval (mkProject { inherit pkgs; source = derivationProject.outPath; });
          invalidDerivationSource = builtins.tryEval (mkProject { inherit pkgs; source = derivationProject; });
          invalidProjectDir = builtins.tryEval (mkProject { inherit pkgs; source = self; projectDir = "../secret"; });
          invalidNoncanonicalProjectDir = builtins.tryEval (mkProject { inherit pkgs; source = self; projectDir = "./templates/basic"; });
          invalidMissingMod = builtins.tryEval (mkProject { inherit pkgs; source = self; projectDir = "cli"; });
          personalSetup = setupFixture.forSetup "personal";
          workSetup = setupFixture.forSetup "work-mac";
          uppercaseSetup = setupFixture.forSetup "uppercase";
          projectionFor = setup: {
            schemaVersion = 1;
            setup = {
              inherit (setup) name root selection;
              harnesses = map (name: { inherit name; paths = setup.harnesses.${name}.paths; }) (builtins.attrNames setup.harnesses);
            };
          };
          consumeSetup = name: setup: pkgs.runCommand "skillful-${name}-destination-map" { } (''
            mkdir -p "$out"
          '' + pkgs.lib.concatStrings (pkgs.lib.mapAttrsToList (destination: file: ''
            destination=${pkgs.lib.escapeShellArg destination}
            target="$out/$destination"
            mkdir -p "$(dirname "$target")"
            ${if file.recursive then "cp -r" else "cp"} ${pkgs.lib.escapeShellArg (toString file.source)} "$target"
          '') setup.files));
          personalHome = consumeSetup "personal" personalSetup;
          workProject = consumeSetup "work-mac" workSetup;
          parseSetupMod = import ./nix/parseMod.nix {
            lib = pkgs.lib;
            facts = { claude = { }; opencode = { }; pi = { }; };
          };
          invalidUnsafe = builtins.tryEval (builtins.deepSeq (parseSetupMod ./tests/fixtures/setup-mod/unsafe/skill.mod) true);
          invalidMixed = builtins.tryEval (builtins.deepSeq (parseSetupMod ./tests/fixtures/setup-mod/mixed/skill.mod) true);
          invalidRootHome = builtins.tryEval (builtins.deepSeq (parseSetupMod ./tests/fixtures/setup-mod/root-home/skill.mod) true);
          unknownSetup = builtins.tryEval (builtins.deepSeq (setupFixture.forSetup "missing") true);
          overlappingSetup = builtins.tryEval (builtins.deepSeq (setupFixture.forSetup "overlap") true);
          nestedOverlappingSetup = builtins.tryEval (builtins.deepSeq (setupFixture.forSetup "nested-overlap") true);
          rootWideSetup = builtins.tryEval (builtins.deepSeq (setupFixture.forSetup "root-wide") true);
          unsupportedCommandSetup = builtins.tryEval (builtins.deepSeq (setupFixture.forSetup "unsupported-command") true);
          setupSourcesInsideRender = setup: builtins.all (file: pkgs.lib.hasPrefix "${setup.rendered}/" (toString file.source)) (builtins.attrValues setup.files);
          lockedFixture = mkProject {
            inherit pkgs;
            source = self;
            projectDir = "tests/fixtures/locked-project";
          };
          sourceMaintenanceFixture = mkProject {
            inherit pkgs;
            source = self + "/tests/fixtures/source-maintenance-project";
            projectDir = "agent";
          };
          githubTree = builtins.fetchTree {
            type = "github";
            owner = "angular";
            repo = "skills";
            rev = "db574d779823fad75472413768838c909f4bf7fa";
            narHash = "sha256-BQBdtRIqsxRJ9i+pUggiTZNUyF6gut97iEBzEtKgx2o=";
          };
        in
        {
          cli = pkgs.runCommandLocal "skillful-cli-tests" {
            nativeBuildInputs = [ pkgs.bun pkgs.gitMinimal pkgs.gnutar ];
          } ''
            cd ${self}
            NODE_PATH=${bunDeps} bun test cli
            touch "$out"
          '';
          standalone = pkgs.runCommandLocal "skillful-standalone-check" { } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful --version > "$TMPDIR/version"
            grep -Fx ${pkgs.lib.escapeShellArg versionLine} "$TMPDIR/version"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful init --dir "$TMPDIR/project"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful list harnesses --project "$TMPDIR/project" > "$TMPDIR/harnesses"
            env -i HOME="$HOME" PATH=/nonexistent ${skillful}/bin/skillful render --project "$TMPDIR/project" --out "$TMPDIR/rendered"
            grep -Fx opencode "$TMPDIR/harnesses"
            test -f "$TMPDIR/rendered/pi/skills/example/SKILL.md"
            touch "$out"
          '';
          source-maintenance = pkgs.runCommand "skillful-source-maintenance-check" {
            nativeBuildInputs = [ skillful pkgs.gitMinimal pkgs.gnutar ];
          } ''
            export HOME="$TMPDIR/home"
            export XDG_CACHE_HOME="$TMPDIR/cache"
            mkdir -p "$HOME" "$XDG_CACHE_HOME" "$out"
            test -f ${sourceMaintenanceFixture.rendered}/pi/skills/agent-jj/SKILL.md
            test ! -e ${sourceMaintenanceFixture.rendered}/codex
            test -f ${sourceMaintenanceFixture.rendered}/pi/skills/local/SKILL.md
            test -f ${(sourceMaintenanceFixture.forHarness "pi").skills}/agent-jj/SKILL.md
            test -f ${(sourceMaintenanceFixture.forHarness "pi").rules}

            remote="$TMPDIR/remote"
            mkdir -p "$remote/angular/angular-skill" "$remote/browser/agent-browser"
            printf '%s\n' '---' 'name: angular-skill' 'description: angular fixture' '---' > "$remote/angular/angular-skill/SKILL.md"
            printf '%s\n' '---' 'name: agent-browser' 'description: browser fixture' '---' > "$remote/browser/agent-browser/SKILL.md"
            git -C "$remote" init -b main >/dev/null
            git -C "$remote" config user.email test@example.invalid
            git -C "$remote" config user.name Test
            git -C "$remote" add .
            git -C "$remote" commit -m initial >/dev/null

            workspace="$TMPDIR/workspace"
            work="$workspace/agent"
            cp -r ${./tests/fixtures/source-maintenance-project} "$workspace"
            chmod -R u+w "$workspace"
            git -C "$workspace" init -b main >/dev/null

            cat >> "$work/skill.mod" <<EOF

            require "git:file://$remote@main#browser" as agent-browser (
              only agent-browser
            )

            require "git:file://$remote@main#angular" as angular-skills (
              only angular-skill
            )
            EOF

            mkdir "$work/nested"
            (cd "$work/nested" && skillful update angular-skills)

            skillful update agent-browser --project "$work"

            cp "$work/skill.lock" "$TMPDIR/lock.before"
            rm -rf "$XDG_CACHE_HOME/skillful"
            skillful fetch --project "$work"
            cmp "$TMPDIR/lock.before" "$work/skill.lock"
            ${skillful}/bin/skillful check --strict --format json --project "$work" --source-root "$workspace" > "$out/pinned-check.json"
          '';
          fixture-render = fixture.rendered;
          fixture-harness = pkgs.runCommand "skillful-fixture-harness-check" { } ''
            test -f ${fixture.rendered}/pi/skills/example/SKILL.md
            test -f ${fixture.rendered}/claude/skills/example/SKILL.md
            test -f ${fixture.rendered}/opencode/skills/example/SKILL.md
            test -f ${(fixture.forHarness "pi").skills}/example/SKILL.md
            test -f ${(fixture.forHarness "pi").commands}/standalone.md
            test -f ${(fixture.forHarness "pi").rules}
            touch "$out"
          '';
          fixture-strict = fixture.checks.strict;
          setup-projection =
            assert !invalidUnsafe.success;
            assert !invalidMixed.success;
            assert !invalidRootHome.success;
            assert !invalidDerivationOutputSource.success;
            assert !invalidDerivationSource.success;
            assert !invalidProjectDir.success;
            assert !invalidMissingMod.success;
            assert !invalidNoncanonicalProjectDir.success;
            assert !unknownSetup.success;
            assert !overlappingSetup.success;
            assert !nestedOverlappingSetup.success;
            assert !rootWideSetup.success;
            assert !unsupportedCommandSetup.success;
            assert setupSourcesInsideRender personalSetup;
            assert setupSourcesInsideRender workSetup;
            assert workSetup.harnesses.opencode.paths.skills == ".opencode/skills";
            assert workSetup.harnesses.opencode.paths.commands == ".opencode/commands";
            assert !(workSetup.harnesses.opencode.paths ? rules);
            pkgs.runCommand "skillful-setup-projection-check" {
              nativeBuildInputs = [ skillful pkgs.jq pkgs.diffutils ];
              expectedSetups = builtins.toJSON {
                personal = projectionFor personalSetup;
                work-mac = projectionFor workSetup;
                uppercase = projectionFor uppercaseSetup;
              };
            } ''
              printf '%s\n' "$expectedSetups" > expected.json
              for name in personal work-mac uppercase; do
                skillful setup show "$name" --format json --project ${self}/tests/fixtures/setup-project \
                  | jq -S '{ schemaVersion, setup: { name: .setup.name, root: .setup.root, selection: .setup.selection, harnesses: (.setup.harnesses | sort_by(.name)) } }' \
                  > "$name-cli.json"
                jq -S --arg name "$name" '.[$name]' expected.json > "$name-nix.json"
                diff -u "$name-nix.json" "$name-cli.json"
              done

              for project in ${./tests/fixtures/setup-mod/unsafe} ${./tests/fixtures/setup-mod/mixed} ${./tests/fixtures/setup-mod/root-home}; do
                if skillful fmt --check --project "$project"; then exit 1; fi
              done
              for name in overlap nested-overlap root-wide; do
                if skillful setup show "$name" --format json --project ${self}/tests/fixtures/setup-project; then exit 1; fi
              done

              test -f ${personalSetup.rendered}/pi/skills/example/SKILL.md
              test ! -e ${personalSetup.rendered}/pi/skills/hidden
              test -f ${workSetup.rendered}/claude/skills/hidden/SKILL.md
              test -f ${uppercaseSetup.rendered}/pi/skills/Upper/SKILL.md
              test ! -e ${uppercaseSetup.rendered}/pi/skills/example
              test -f ${personalHome}/.pi/agent/skills/example/SKILL.md
              test ! -e ${personalHome}/.pi/agent/skills/hidden
              test -f ${workProject}/.claude2/skills/hidden/SKILL.md
              test ${pkgs.lib.escapeShellArg workSetup.root} = project
              touch "$out"
            '';
          locked-render = pkgs.runCommand "skillful-locked-render-check" { } ''
            test -f ${lockedFixture.rendered}/pi/skills/local/SKILL.md
            test -f ${lockedFixture.rendered}/pi/skills/angular-developer/SKILL.md
            test -f ${(lockedFixture.forHarness "pi").skills}/angular-developer/SKILL.md
            touch "$out"
          '';
          github-transport = pkgs.runCommand "skillful-github-transport" {
            nativeBuildInputs = [ pkgs.bun pkgs.gnutar pkgs.cacert ];
            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
            outputHash = "sha256-Vz1x6g+awrVYM9aNcbjsjsMGX+TGOMrI7OpobqVjK9Y=";
          } ''
            export HOME="$TMPDIR/home"
            export XDG_CACHE_HOME="$TMPDIR/cache"
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            mkdir -p "$HOME" "$XDG_CACHE_HOME" "$out"
            bun ${self}/cli/github-integration.ts "$XDG_CACHE_HOME" ${githubTree.outPath}
            printf 'ok\n' > "$out/result"
          '';
        });

      templates.basic = {
        path = ./templates/basic;
        description = "A small skillful project";
        welcomeText = ''
          A basic skillful project was created. Edit skill.mod and the
          resources under skills/, commands/, and rules/ before rendering.
        '';
      };
    };
}
