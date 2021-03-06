/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'neuroglancer/render_layer_backend';

import {Chunk, ChunkConstructor, ChunkSource, withChunkManager} from 'neuroglancer/chunk_manager/backend';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {filterVisibleSources, forEachPlaneIntersectingVolumetricChunk, MultiscaleVolumetricDataRenderLayer, SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RENDERLAYER_RPC_ID, SLICEVIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, SliceViewRenderLayer as SliceViewRenderLayerInterface, TransformedSource} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {getBasePriority, getPriorityTier, withSharedVisibility} from 'neuroglancer/visibility_priority/backend';
import {registerRPC, registerSharedObject, RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';

export const BASE_PRIORITY = -1e12;
export const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

class SliceViewCounterpartBase extends
    SliceViewBase<SliceViewChunkSourceBackend, SliceViewRenderLayerBackend> {
  constructor(rpc: RPC, options: any) {
    super(rpc.get(options.projectionParameters));
    this.initializeSharedObject(rpc, options['id']);
  }
}

function disposeTransformedSources(
    allSources: TransformedSource<SliceViewRenderLayerBackend, SliceViewChunkSourceBackend>[][]) {
  for (const scales of allSources) {
    for (const tsource of scales) {
      tsource.source.dispose();
    }
  }
}

const SliceViewIntermediateBase = withSharedVisibility(withChunkManager(SliceViewCounterpartBase));
@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceViewBackend extends SliceViewIntermediateBase {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateVisibleChunks();
    }));
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  handleLayerChanged = (() => {
    this.chunkManager.scheduleUpdateChunkPriorities();
  });

  updateVisibleChunks() {
    const projectionParameters = this.projectionParameters.value;
    let chunkManager = this.chunkManager;
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    this.updateVisibleSources();
    const {centerDataPosition} = projectionParameters;
    const priorityTier = getPriorityTier(visibility);
    let basePriority = getBasePriority(visibility);
    basePriority += BASE_PRIORITY;

    const localCenter = tempCenter;

    const chunkSize = tempChunkSize;

    for (const visibleLayerSources of this.visibleLayers.values()) {
      const {visibleSources} = visibleLayerSources;
      for (let i = 0, numVisibleSources = visibleSources.length; i < numVisibleSources; ++i) {
        const tsource = visibleSources[i];
        const {chunkLayout} = tsource;
        chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
        const {size, finiteRank} = chunkLayout;
        vec3.copy(chunkSize, size);
        for (let i = finiteRank; i < 3; ++i) {
          chunkSize[i] = 0;
          localCenter[i] = 0;
        }
        const priorityIndex = i;
        const sourceBasePriority = basePriority + SCALE_PRIORITY_MULTIPLIER * priorityIndex;
        forEachPlaneIntersectingVolumetricChunk(
            projectionParameters, tsource.renderLayer.localPosition.value, tsource,
            positionInChunks => {
              vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
              let priority = -vec3.distance(localCenter, tempChunkPosition);
              let chunk = tsource.source.getChunk(tsource.curPositionInChunks);
              chunkManager.requestChunk(chunk, priorityTier, sourceBasePriority + priority);
            });
      }
    }
  }

  removeVisibleLayer(layer: SliceViewRenderLayerBackend) {
    const {visibleLayers} = this;
    const layerInfo = visibleLayers.get(layer)!;
    visibleLayers.delete(layer);
    disposeTransformedSources(layerInfo.allSources);
    layer.renderScaleTarget.changed.remove(this.invalidateVisibleSources);
    layer.localPosition.changed.remove(this.handleLayerChanged);
    this.invalidateVisibleSources();
  }

  addVisibleLayer(
      layer: SliceViewRenderLayerBackend,
      allSources: TransformedSource<SliceViewRenderLayerBackend, SliceViewChunkSourceBackend>[][]) {
    const {displayDimensionRenderInfo} = this.projectionParameters.value;
    let layerInfo = this.visibleLayers.get(layer);
    if (layerInfo === undefined) {
      layerInfo = {
        allSources,
        visibleSources: [],
        displayDimensionRenderInfo: displayDimensionRenderInfo,
      };
      this.visibleLayers.set(layer, layerInfo);
      layer.renderScaleTarget.changed.add(() => this.invalidateVisibleSources());
      layer.localPosition.changed.add(this.handleLayerChanged);
    } else {
      disposeTransformedSources(layerInfo.allSources);
      layerInfo.allSources = allSources;
      layerInfo.visibleSources.length = 0;
      layerInfo.displayDimensionRenderInfo = displayDimensionRenderInfo;
    }
    this.invalidateVisibleSources();
  }

  disposed() {
    for (let layer of this.visibleLayers.keys()) {
      this.removeVisibleLayer(layer);
    }
    super.disposed();
  }

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }
}

export function deserializeTransformedSources<
    Source extends SliceViewChunkSourceBackend, RLayer extends MultiscaleVolumetricDataRenderLayer>(
    rpc: RPC, serializedSources: any[][], layer: any) {
  const sources = serializedSources.map(
      scales => scales.map((serializedSource): TransformedSource<RLayer, Source> => {
        const source = rpc.getRef<Source>(serializedSource.source);
        const chunkLayout = serializedSource.chunkLayout;
        const {rank} = source.spec;
        const tsource: TransformedSource<RLayer, Source> = {
          renderLayer: layer,
          source,
          chunkLayout: ChunkLayout.fromObject(chunkLayout),
          layerRank: serializedSource.layerRank,
          nonDisplayLowerClipBound: serializedSource.nonDisplayLowerClipBound,
          nonDisplayUpperClipBound: serializedSource.nonDisplayUpperClipBound,
          lowerClipDisplayBound: serializedSource.lowerClipDisplayBound,
          upperClipDisplayBound: serializedSource.upperClipDisplayBound,
          lowerChunkDisplayBound: serializedSource.lowerChunkDisplayBound,
          upperChunkDisplayBound: serializedSource.upperChunkDisplayBound,
          effectiveVoxelSize: serializedSource.effectiveVoxelSize,
          chunkDisplayDimensionIndices: serializedSource.chunkDisplayDimensionIndices,
          fixedLayerToChunkTransform: serializedSource.fixedLayerToChunkTransform,
          curPositionInChunks: new Float32Array(rank),
          fixedPositionWithinChunk: new Uint32Array(rank),
        };
        return tsource;
      }));
  return sources;
}
registerRPC(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, function(x) {
  const obj = <SliceViewBackend>this.get(x['id']);
  const layer = <SliceViewRenderLayerBackend>this.get(x['layerId']);
  const sources =
      deserializeTransformedSources<SliceViewChunkSourceBackend, SliceViewRenderLayerBackend>(
          this, x.sources, layer);
  obj.addVisibleLayer(layer, sources);
});
registerRPC(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, function(x) {
  let obj = <SliceViewBackend>this.get(x['id']);
  let layer = <SliceViewRenderLayerBackend>this.get(x['layerId']);
  obj.removeVisibleLayer(layer);
});

export class SliceViewChunk extends Chunk {
  chunkGridPosition: Float32Array;
  source: SliceViewChunkSourceBackend|null = null;

  constructor() {
    super();
  }

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg['chunkGridPosition'] = this.chunkGridPosition;
  }

  downloadSucceeded() {
    super.downloadSucceeded();
  }

  freeSystemMemory() {}

  toString() {
    return this.source!.toString() + ':' + vec3Key(this.chunkGridPosition);
  }
}

export interface SliceViewChunkSourceBackend<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
                 ChunkType extends SliceViewChunk = SliceViewChunk> {
  // TODO(jbms): Move this declaration to the class definition below and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(chunkGridPosition: vec3): ChunkType;

  chunkConstructor: ChunkConstructor<SliceViewChunk>;
}

export class SliceViewChunkSourceBackend<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
                 ChunkType extends SliceViewChunk = SliceViewChunk> extends ChunkSource implements
    SliceViewChunkSourceInterface {
  spec: Spec;
  chunks: Map<string, ChunkType>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
  }

  getChunk(chunkGridPosition: Float32Array) {
    const key = chunkGridPosition.join();
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(this.chunkConstructor) as ChunkType;
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class SliceViewRenderLayerBackend extends SharedObjectCounterpart implements
    SliceViewRenderLayerInterface {
  rpcId: number;
  renderScaleTarget: SharedWatchableValue<number>;
  localPosition: WatchableValueInterface<Float32Array>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
  }

  filterVisibleSources(sliceView: SliceViewBase, sources: readonly TransformedSource[]):
      Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }
}
