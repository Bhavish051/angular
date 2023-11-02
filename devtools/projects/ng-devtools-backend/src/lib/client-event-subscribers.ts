/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ComponentExplorerViewQuery, ComponentType, DevToolsNode, DirectivePosition, DirectiveType, ElementPosition, Events, MessageBus, ProfilerFrame, SerializedInjector, SerializedProviderRecord} from 'protocol';
import {debounceTime} from 'rxjs/operators';

import {appIsAngularInDevMode, appIsAngularIvy, appIsSupportedAngularVersion, getAngularVersion,} from './angular-check';
import {ComponentInspector} from './component-inspector/component-inspector';
import {getInjectorFromElementNode, getInjectorProviders, getInjectorResolutionPath, getLatestComponentState, hasDiDebugAPIs, idToInjector, injectorsSeen, isElementInjector, queryDirectiveForest, serializeElementInjectorWithId, serializeEnvironmentInjectorWithId, serializeProviderRecord, updateState} from './component-tree';
import {unHighlight} from './highlighter';
import {disableTimingAPI, enableTimingAPI, initializeOrGetDirectiveForestHooks} from './hooks';
import {start as startProfiling, stop as stopProfiling} from './hooks/capture';
import {ComponentTreeNode} from './interfaces';
import {setConsoleReference} from './set-console-reference';
import {serializeDirectiveState} from './state-serializer/state-serializer';
import {runOutsideAngular} from './utils';

export const subscribeToClientEvents = (messageBus: MessageBus<Events>): void => {
  messageBus.on('shutdown', shutdownCallback(messageBus));

  messageBus.on(
      'getLatestComponentExplorerView', getLatestComponentExplorerViewCallback(messageBus));

  messageBus.on('queryNgAvailability', checkForAngularCallback(messageBus));

  messageBus.on('startProfiling', startProfilingCallback(messageBus));
  messageBus.on('stopProfiling', stopProfilingCallback(messageBus));

  messageBus.on('setSelectedComponent', selectedComponentCallback);

  messageBus.on('getNestedProperties', getNestedPropertiesCallback(messageBus));
  messageBus.on('getRoutes', getRoutesCallback(messageBus));

  messageBus.on('updateState', updateState);

  messageBus.on('enableTimingAPI', enableTimingAPI);
  messageBus.on('disableTimingAPI', disableTimingAPI);

  messageBus.on('getInjectorProviders', getInjectorProvidersCallback(messageBus));

  messageBus.on('logProvider', logProvider);

  if (appIsAngularInDevMode() && appIsSupportedAngularVersion() && appIsAngularIvy()) {
    setupInspector(messageBus);
    // Often websites have `scroll` event listener which triggers
    // Angular's change detection. We don't want to constantly send
    // update requests, instead we want to request an update at most
    // once every 250ms
    runOutsideAngular(() => {
      initializeOrGetDirectiveForestHooks()
          .profiler.changeDetection$.pipe(debounceTime(250))
          .subscribe(() => messageBus.emit('componentTreeDirty'));
    });
  }
};

//
// Callback Definitions
//

const shutdownCallback = (messageBus: MessageBus<Events>) => () => {
  messageBus.destroy();
};

const getLatestComponentExplorerViewCallback = (messageBus: MessageBus<Events>) =>
    (query?: ComponentExplorerViewQuery) => {
      // We want to force re-indexing of the component tree.
      // Pressing the refresh button means the user saw stuck UI.

      initializeOrGetDirectiveForestHooks().indexForest();

      let forest: SerializableComponentTreeNode[];

      if (hasDiDebugAPIs()) {
        forest = prepareForestForSerialization(
            initializeOrGetDirectiveForestHooks().getIndexedDirectiveForest(), true);

        // cleanup injector id mappings
        for (const injectorId of idToInjector.keys()) {
          if (!injectorsSeen.has(injectorId)) {
            idToInjector.delete(injectorId);
          }
        }
        injectorsSeen.clear();
      } else {
        forest = prepareForestForSerialization(
            initializeOrGetDirectiveForestHooks().getIndexedDirectiveForest());
      }

      if (!query) {
        messageBus.emit('latestComponentExplorerView', [{forest}]);
        return;
      }

      const state = getLatestComponentState(
          query, initializeOrGetDirectiveForestHooks().getDirectiveForest());
      if (state) {
        const {directiveProperties} = state;
        messageBus.emit('latestComponentExplorerView', [{forest, properties: directiveProperties}]);
      }
    };

const checkForAngularCallback = (messageBus: MessageBus<Events>) => () =>
    checkForAngular(messageBus);
const getRoutesCallback = (messageBus: MessageBus<Events>) => () => getRoutes(messageBus);

const startProfilingCallback = (messageBus: MessageBus<Events>) => () =>
    startProfiling((frame: ProfilerFrame) => {
      messageBus.emit('sendProfilerChunk', [frame]);
    });

const stopProfilingCallback = (messageBus: MessageBus<Events>) => () => {
  messageBus.emit('profilerResults', [stopProfiling()]);
};

const selectedComponentCallback = (position: ElementPosition) => {
  const node = queryDirectiveForest(
      position, initializeOrGetDirectiveForestHooks().getIndexedDirectiveForest());
  setConsoleReference({node, position});
};

const getNestedPropertiesCallback = (messageBus: MessageBus<Events>) => (
    position: DirectivePosition, propPath: string[]) => {
  const emitEmpty = () => messageBus.emit('nestedProperties', [position, {props: {}}, propPath]);
  const node = queryDirectiveForest(
      position.element, initializeOrGetDirectiveForestHooks().getIndexedDirectiveForest());
  if (!node) {
    return emitEmpty();
  }
  const current =
      position.directive === undefined ? node.component : node.directives[position.directive];
  if (!current) {
    return emitEmpty();
  }
  let data = current.instance;
  for (const prop of propPath) {
    data = data[prop];
    if (!data) {
      console.error('Cannot access the properties', propPath, 'of', node);
    }
  }
  messageBus.emit('nestedProperties', [position, {props: serializeDirectiveState(data)}, propPath]);
  return;
};

//
// Subscribe Helpers
//

// todo: parse router tree with framework APIs after they are developed
const getRoutes = (messageBus: MessageBus<Events>) => {
  // Return empty router tree to disable tab.
  messageBus.emit('updateRouterTree', [[]]);
};

const checkForAngular = (messageBus: MessageBus<Events>): void => {
  const ngVersion = getAngularVersion();
  const appIsIvy = appIsAngularIvy();
  if (!ngVersion) {
    setTimeout(() => checkForAngular(messageBus), 500);
    return;
  }

  if (appIsIvy && appIsAngularInDevMode() && appIsSupportedAngularVersion()) {
    initializeOrGetDirectiveForestHooks();
  }

  messageBus.emit('ngAvailability', [
    {version: ngVersion.toString(), devMode: appIsAngularInDevMode(), ivy: appIsIvy},
  ]);
};

const setupInspector = (messageBus: MessageBus<Events>) => {
  const inspector = new ComponentInspector({
    onComponentEnter: (id: number) => {
      messageBus.emit('highlightComponent', [id]);
    },
    onComponentLeave: () => {
      messageBus.emit('removeComponentHighlight');
    },
    onComponentSelect: (id: number) => {
      messageBus.emit('selectComponent', [id]);
    },
  });

  messageBus.on('inspectorStart', inspector.startInspecting);
  messageBus.on('inspectorEnd', inspector.stopInspecting);

  messageBus.on('createHighlightOverlay', (position: ElementPosition) => {
    inspector.highlightByPosition(position);
  });
  messageBus.on('removeHighlightOverlay', unHighlight);
};

export interface SerializableDirectiveInstanceType extends DirectiveType {
  id: number;
}

export interface SerializableComponentInstanceType extends ComponentType {
  id: number;
}

export interface SerializableComponentTreeNode extends
    DevToolsNode<SerializableDirectiveInstanceType, SerializableComponentInstanceType> {
  children: SerializableComponentTreeNode[];
}

// Here we drop properties to prepare the tree for serialization.
// We don't need the component instance, so we just traverse the tree
// and leave the component name.
const prepareForestForSerialization = (roots: ComponentTreeNode[], includeResolutionPath = false):
    SerializableComponentTreeNode[] => {
      const serializedNodes: SerializableComponentTreeNode[] = [];
      for (const node of roots) {
        const serializedNode = {
          element: node.element,
          component: node.component ? {
            name: node.component.name,
            isElement: node.component.isElement,
            id: initializeOrGetDirectiveForestHooks().getDirectiveId(node.component.instance),
          } :
                                      null,
          directives: node.directives.map(
              (d) => ({
                name: d.name,
                id: initializeOrGetDirectiveForestHooks().getDirectiveId(d.instance),
              })),
          children: prepareForestForSerialization(node.children, includeResolutionPath),
        } as SerializableComponentTreeNode;

        if (includeResolutionPath) {
          const nodeInjector = getInjectorFromElementNode(node.nativeElement!);
          if (!nodeInjector) {
            serializedNode['resolutionPath'] = [];
            serializedNodes.push(serializedNode);
            continue;
          }

          const serializedResolutionPath: SerializedInjector[] = [];

          for (const injector of getInjectorResolutionPath(nodeInjector!)) {
            let serializedInjectorWithId: SerializedInjector|null = null;

            if (isElementInjector(injector)) {
              serializedInjectorWithId = serializeElementInjectorWithId(injector);
            } else {
              serializedInjectorWithId = serializeEnvironmentInjectorWithId(injector);
            }

            if (serializedInjectorWithId === null) {
              continue;
            }

            serializedResolutionPath.push(serializedInjectorWithId);
          }

          serializedNode.resolutionPath = serializedResolutionPath;
        }

        serializedNodes.push(serializedNode);
      }

      return serializedNodes;
    };


const getInjectorProvidersCallback = (messageBus: MessageBus<Events>) =>
    (injector: SerializedInjector) => {
      if (!idToInjector.has(injector.id)) {
        return;
      }

      const providerRecords = getInjectorProviders(idToInjector.get(injector.id)!);
      let serializedProviderRecords: SerializedProviderRecord[] = [];

      if (injector.type === 'environment') {
        serializedProviderRecords = providerRecords.map((providerRecord) => {
          return serializeProviderRecord(providerRecord, true);
        });
      } else {
        serializedProviderRecords = providerRecords.map((providerRecord) => {
          return serializeProviderRecord(providerRecord);
        });
      }

      messageBus.emit('latestInjectorProviders', [injector, serializedProviderRecords]);
    };

const logProvider =
    (serializedInjector: SerializedInjector, serializedProvider: SerializedProviderRecord):
        void => {
          if (!idToInjector.has(serializedInjector.id)) {
            return;
          }

          const injector = idToInjector.get(serializedInjector.id)!;

          const providerRecords = getInjectorProviders(injector);

          console.group(
              `%c${serializedInjector.name}`,
              `color: ${
                  serializedInjector.type === 'element' ?
                      '#a7d5a9' :
                      '#f05057'}; font-size: 1.25rem; font-weight: bold;`);
          // tslint:disable-next-line:no-console
          console.log('injector: ', injector);

          if (typeof serializedProvider.index === 'number') {
            const provider = providerRecords[serializedProvider.index];

            // tslint:disable-next-line:no-console
            console.log('provider: ', provider);
            // tslint:disable-next-line:no-console
            console.log(`value: `, injector.get(provider.token, null, {optional: true}));
          } else {
            const providers =
                (serializedProvider.index as number[]).map(index => providerRecords[index]);

            // tslint:disable-next-line:no-console
            console.log('providers: ', providers);
            // tslint:disable-next-line:no-console
            console.log(`value: `, injector.get(providers[0].token, null, {optional: true}));
          }

          console.groupEnd();
        };
