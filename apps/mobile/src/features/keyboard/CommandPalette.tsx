import { useNavigation } from "@react-navigation/native";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
} from "./commandPaletteItems";
import { parseActiveThreadPath, type HardwareKeyboardCommand } from "./hardwareKeyboardCommands";
import { threadJumpIndex } from "./threadKeyboardShortcuts";

const PALETTE_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [
  "commandPalette",
  "paletteDismiss",
  "paletteNext",
  "palettePrevious",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
];
const ROW_HEIGHT = 64;

/** Mounted only while open, so the app root does not subscribe to the full thread catalog. */
export function CommandPalette(props: {
  readonly pathname: string;
  readonly onClose: () => void;
  readonly onCommand: (command: HardwareKeyboardCommand) => void;
}) {
  const navigation = useNavigation();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const runCommand = props.onCommand;
  const projects = useProjects();
  const threads = useThreadShells();
  const activeThreadRef = useMemo(() => parseActiveThreadPath(props.pathname), [props.pathname]);
  const activeThread = useThreadShell(activeThreadRef);
  const { environments } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const pendingAction = useRef<(() => void) | null>(null);
  const closing = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<CommandPaletteItem>>(null);
  const { width, height } = useWindowDimensions();
  const searchEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const search = useThreadSearch(searchEnvironmentIds, query.startsWith(">") ? "" : query);
  const matchedThreadKeys = useMemo(
    () =>
      new Set(search.matches.map((match) => scopedThreadKey(match.environmentId, match.threadId))),
    [search.matches],
  );
  const items = useMemo(() => {
    const actions: CommandPaletteItem[] = [
      {
        key: "newTask",
        kind: "action",
        title: "New thread in…",
        searchTerms: ["new task", "chat", "create", "project"],
        run: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
      },
      {
        key: "addProject",
        kind: "action",
        title: "Add project",
        searchTerms: ["folder", "clone", "repository", "git"],
        run: () => navigation.navigate("NewTaskSheet", { screen: "AddProject" }),
      },
      {
        key: "settings",
        kind: "action",
        title: "Open settings",
        searchTerms: ["preferences", "configuration"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "Settings" },
          }),
      },
      {
        key: "appearance",
        kind: "action",
        title: "Appearance",
        searchTerms: ["theme", "colors", "dark", "light"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsAppearance" },
          }),
      },
      {
        key: "environments",
        kind: "action",
        title: "Manage environments",
        searchTerms: ["connections", "server", "remote"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsEnvironments" },
          }),
      },
      {
        key: "usage",
        kind: "action",
        title: "Usage",
        searchTerms: ["limits", "accounts", "quota"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsUsage" },
          }),
      },
      {
        key: "archive",
        kind: "action",
        title: "Archived threads",
        searchTerms: ["restore", "history"],
        run: () =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsArchive" },
          }),
      },
    ];
    const projectByKey = new Map(
      projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
    );
    const activeProject = activeThread
      ? projectByKey.get(scopedProjectKey(activeThread.environmentId, activeThread.projectId))
      : null;
    if (activeProject) {
      actions.unshift({
        key: "newThread",
        kind: "action",
        title: `New thread in ${activeProject.title}`,
        searchTerms: ["new task", "chat", "create"],
        run: () =>
          navigation.navigate("NewTaskSheet", {
            screen: "NewTaskDraft",
            params: {
              environmentId: activeProject.environmentId,
              projectId: activeProject.id,
              title: activeProject.title,
            },
          }),
      });
    }
    if (activeThreadRef) {
      const threadActions = [
        ["files", "Go to file", ["open", "files", "browse", "search"]],
        ["terminal", "Open terminal", ["shell", "console"]],
        ["review", "Review changes", ["diff", "git", "pull request"]],
        ["copyThreadReference", "Copy PR link or thread ID", ["reference", "clipboard"]],
      ] as const;
      actions.push(
        ...threadActions.map(([command, title, searchTerms]) => ({
          key: command,
          kind: "action" as const,
          title,
          searchTerms,
          run: () => runCommand(command),
        })),
      );
    }
    const projectItems: CommandPaletteItem[] = projects.map((project) => ({
      key: `project:${scopedProjectKey(project.environmentId, project.id)}`,
      kind: "project",
      title: project.title,
      detail: `New thread · ${savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId}`,
      searchTerms: [project.workspaceRoot, "new thread", "project"],
      run: () =>
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: project.environmentId,
            projectId: project.id,
            title: project.title,
          },
        }),
    }));
    const threadItems: CommandPaletteItem[] = threads
      .filter((thread) => thread.archivedAt === null)
      .sort((left, right) =>
        (right.latestUserMessageAt ?? right.updatedAt).localeCompare(
          left.latestUserMessageAt ?? left.updatedAt,
        ),
      )
      .map((thread) => {
        const project = projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
        const environment =
          savedConnectionsById[thread.environmentId]?.environmentLabel ?? thread.environmentId;
        return {
          key: scopedThreadKey(thread.environmentId, thread.id),
          kind: "thread",
          title: thread.title || "Untitled thread",
          detail: [project?.title, environment].filter(Boolean).join(" · "),
          searchTerms: [
            project?.title ?? "",
            environment,
            thread.branch ?? "",
            ...threadPullRequestSearchTerms(thread),
          ],
          run: () => selectThread(thread),
        };
      });
    return [...actions, ...projectItems, ...threadItems];
  }, [
    activeThread,
    activeThreadRef,
    navigation,
    projects,
    runCommand,
    savedConnectionsById,
    selectThread,
    threads,
  ]);
  const results = useMemo(
    () => filterCommandPaletteItems(items, query, matchedThreadKeys),
    [items, matchedThreadKeys, query],
  );
  const selectedIndex = Math.max(
    0,
    results.findIndex((item) => item.key === selection),
  );
  const selectedKey = results[selectedIndex]?.key;
  useEffect(() => {
    if (selectedIndex === 0) {
      // Centering before the list measures its height scrolls half the first row out of view.
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    } else if (selectedKey !== undefined) {
      listRef.current?.scrollToIndex({ index: selectedIndex, animated: false, viewPosition: 0.5 });
    }
  }, [selectedIndex, selectedKey]);

  function close(run?: () => void) {
    if (closing.current) return;
    closing.current = true;
    pendingAction.current = run ?? null;
    setVisible(false);
  }

  function onCommand(command: HardwareKeyboardCommand) {
    if (command === "commandPalette" || command === "paletteDismiss") {
      close();
    } else if (command === "paletteNext" || command === "palettePrevious") {
      setSelection(
        results[nextPaletteIndex(selectedIndex, command === "paletteNext" ? 1 : -1, results.length)]
          ?.key ?? null,
      );
    } else {
      const item = results[threadJumpIndex(command)];
      if (item) close(item.run);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onShow={() => inputRef.current?.focus()}
      onRequestClose={() => close()}
      onDismiss={() => {
        // Present navigation sheets only after UIKit has dismissed this modal.
        props.onClose();
        pendingAction.current?.();
      }}
    >
      <T3KeyboardCommands enabledCommands={PALETTE_COMMANDS} onCommand={onCommand}>
        <KeyboardAvoidingView
          behavior="padding"
          className="flex-1 items-center justify-center bg-black/40 p-4"
        >
          <Pressable
            className="absolute inset-0"
            accessibilityLabel="Close command palette"
            onPress={() => close()}
          />
          <View
            accessibilityViewIsModal
            className="overflow-hidden rounded-2xl border border-border bg-sheet-solid"
            style={{ width: Math.min(600, width - 32), height: Math.min(520, height - 80) }}
          >
            <View className="flex-row items-center gap-2 border-b border-border p-3">
              <AppTextInput
                ref={inputRef}
                accessibilityLabel="Search commands, projects, and threads"
                placeholder="Search commands, projects, and threads…"
                autoCorrect={false}
                autoCapitalize="none"
                className="flex-1"
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setSelection(null);
                  listRef.current?.scrollToOffset({ offset: 0, animated: false });
                }}
                returnKeyType="go"
                submitBehavior="submit"
                onSubmitEditing={() => {
                  const item = results[selectedIndex];
                  if (item) close(item.run);
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close command palette"
                className="min-h-11 justify-center px-2"
                onPress={() => close()}
              >
                <Text className="text-primary">Cancel</Text>
              </Pressable>
            </View>
            <FlatList
              ref={listRef}
              data={results}
              extraData={selectedKey}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => item.key}
              getItemLayout={(_, index) => ({
                length: ROW_HEIGHT,
                offset: ROW_HEIGHT * index,
                index,
              })}
              ListEmptyComponent={
                <Text className="p-5 text-center text-foreground-muted">
                  {search.isPending ? "Searching…" : "No results"}
                </Text>
              }
              renderItem={({ item, index }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.key === selectedKey }}
                  onPress={() => close(item.run)}
                  className={
                    item.key === selectedKey
                      ? "flex-row items-center gap-3 bg-primary/10 px-4"
                      : "flex-row items-center gap-3 px-4"
                  }
                  style={{ height: ROW_HEIGHT }}
                >
                  <View className="flex-1">
                    <Text numberOfLines={1} className="text-base">
                      {item.title}
                    </Text>
                    {item.detail ? (
                      <Text numberOfLines={1} className="text-sm text-foreground-muted">
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {index < 9 ? (
                    <Text className="text-sm text-foreground-muted">⌘{index + 1}</Text>
                  ) : null}
                </Pressable>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </T3KeyboardCommands>
    </Modal>
  );
}
