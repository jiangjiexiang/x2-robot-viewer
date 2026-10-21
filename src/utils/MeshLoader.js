/**
 * Mesh file loading utility
 * Unified management of STL, OBJ, DAE, GLTF and other format loading
 */
import * as THREE from 'three';
import { normalizePath, resolveFileFromMap } from './FileUtils.js';

// Cache loaders for performance
let loadersCache = null;

/**
 * Get or create loaders instance (singleton pattern)
 */
async function getLoaders() {
    if (!loadersCache) {
        const [
            { STLLoader },
            { OBJLoader },
            { MTLLoader },
            { ColladaLoader },
            { GLTFLoader }
        ] = await Promise.all([
            import('three/examples/jsm/loaders/STLLoader.js'),
            import('three/examples/jsm/loaders/OBJLoader.js'),
            import('three/examples/jsm/loaders/MTLLoader.js'),
            import('three/examples/jsm/loaders/ColladaLoader.js'),
            import('three/examples/jsm/loaders/GLTFLoader.js')
        ]);
        loadersCache = {
            STLLoader: new STLLoader(),
            OBJLoader: new OBJLoader(),
            MTLLoader: new MTLLoader(),
            ColladaLoader: new ColladaLoader(),
            GLTFLoader: new GLTFLoader()
        };
    }
    return loadersCache;
}

/**
 * Load single mesh file
 * @param {string} meshPath - Mesh file path
 * @param {Map} fileMap - File map
 * @returns {Promise<THREE.BufferGeometry|THREE.Group|null>}
 */
export async function loadMeshFile(meshPath, fileMap) {
    try {
        let file = resolveFileFromMap(meshPath, fileMap);

        // Try adding extensions
        const normalizedPath = normalizePath(meshPath);
        if (!file && !normalizedPath.includes('.')) {
            const commonExts = ['.stl', '.obj', '.dae', '.gltf', '.glb'];
            for (const ext of commonExts) {
                const pathWithExt = normalizedPath + ext;
                file = resolveFileFromMap(pathWithExt, fileMap);
                if (file) {
                    break;
                }
            }
        }

        if (!file) {
            console.error(`Cannot find mesh file: ${meshPath}`);
            return null;
        }

        // Determine file extension
        const fileExt = file.name ? file.name.toLowerCase().split('.').pop() : meshPath.toLowerCase().split('.').pop();
        const url = URL.createObjectURL(file);

        try {
            const loaders = await getLoaders();
            let geometry = null;

            switch (fileExt) {
                case 'stl':
                    geometry = await new Promise((resolve, reject) => {
                        loaders.STLLoader.load(url, resolve, undefined, reject);
                    });
                    break;

                case 'obj':
                    // Try loading MTL file
                    const mtlFileName = file.name.replace(/\.obj$/i, '.mtl');
                    const mtlFile = Array.from(fileMap.values()).find(f =>
                        f.name && f.name.toLowerCase() === mtlFileName.toLowerCase()
                    );

                    if (mtlFile) {
                        try {
                            const mtlUrl = URL.createObjectURL(mtlFile);
                            const materials = await new Promise((resolve, reject) => {
                                loaders.MTLLoader.load(mtlUrl, resolve, undefined, reject);
                            });
                            URL.revokeObjectURL(mtlUrl);
                            materials.preload();
                            loaders.OBJLoader.setMaterials(materials);
                        } catch (error) {
                            console.warn('MTL file loading failed:', error);
                        }
                    }

                    geometry = await new Promise((resolve, reject) => {
                        loaders.OBJLoader.load(url, resolve, undefined, reject);
                    });

                    loaders.OBJLoader.setMaterials(null);
                    break;

                case 'dae':
                    const daeResult = await new Promise((resolve, reject) => {
                        loaders.ColladaLoader.load(url, resolve, undefined, reject);
                    });
                    geometry = daeResult ? daeResult.scene : null;
                    break;

                case 'gltf':
                case 'glb':
                    const gltfResult = await new Promise((resolve, reject) => {
                        loaders.GLTFLoader.load(url, resolve, undefined, reject);
                    });
                    geometry = gltfResult ? gltfResult.scene : null;
                    break;

                default:
                    console.warn(`Unsupported mesh file format: ${fileExt}`);
                    URL.revokeObjectURL(url);
                    return null;
            }

            URL.revokeObjectURL(url);

            // Ensure all meshes in loaded geometry have Phong materials with proper lighting
            // This is critical for DAE/OBJ files which may have nested Groups
            if (geometry && (geometry.isGroup || geometry.isObject3D || geometry.isScene)) {
                ensureMeshHasPhongMaterial(geometry);
            }

            return geometry;
        } catch (error) {
            URL.revokeObjectURL(url);
            console.error(`Failed to load mesh file: ${meshPath}`, error);
            return null;
        }
    } catch (error) {
        console.error(`Failed to process mesh file: ${meshPath}`, error);
        return null;
    }
}

/**
 * Ensure mesh uses lighting-compatible material
 * Enhanced for better lighting (MuJoCo style)
 */
export function ensureMeshHasPhongMaterial(meshObject) {
    meshObject.traverse((child) => {
        if (child.isMesh && child.material) {
            // Handle material arrays (common in DAE files with multiple materials)
            const materials = Array.isArray(child.material) ? child.material : [child.material];

            materials.forEach((material, matIndex) => {
                if (!material) return;

                // Convert MeshBasicMaterial or MeshLambertMaterial to MeshPhongMaterial
                if (material.type === 'MeshBasicMaterial' || material.type === 'MeshLambertMaterial') {
                    const oldMaterial = material;
                    const enhancedLighting = typeof window !== 'undefined' && window.app?.sceneManager?.visualizationManager?.showEnhancedLighting !== false;
                    const envMap = typeof window !== 'undefined' && window.app?.sceneManager?.environmentManager?.getEnvironmentMap();
                    const newMaterial = new THREE.MeshPhongMaterial({
                        color: oldMaterial.color,
                        map: oldMaterial.map,
                        transparent: oldMaterial.transparent,
                        opacity: oldMaterial.opacity,
                        side: oldMaterial.side,
                        shininess: enhancedLighting ? 50 : 30,
                        specular: enhancedLighting ? new THREE.Color(0.3, 0.3, 0.3) : new THREE.Color(0x111111),
                        envMap: envMap || null,
                        reflectivity: envMap ? 0.3 : 0
                    });
                    // Save original properties for lighting toggle
                    newMaterial.userData.originalShininess = 30;
                    newMaterial.userData.originalSpecular = null; // New material, no original specular
                    if (newMaterial.map) {
                        newMaterial.map.colorSpace = THREE.SRGBColorSpace;
                    }
                    materials[matIndex] = newMaterial;
                } else if (material.isMeshPhongMaterial || material.isMeshStandardMaterial) {
                    // Save original properties before enhancing (for lighting toggle)
                    if (material.userData.originalShininess === undefined) {
                        material.userData.originalShininess = material.shininess !== undefined ? material.shininess : 30;
                        // Save original specular - if material had no specular, save null
                        if (!material.specular) {
                            material.userData.originalSpecular = null;
                        } else if (material.specular.isColor) {
                            const spec = material.specular;
                            if (spec.r < 0.1 && spec.g < 0.1 && spec.b < 0.1) {
                                material.userData.originalSpecular = null; // Likely default
                            } else {
                                material.userData.originalSpecular = spec.clone();
                            }
                        } else if (typeof material.specular === 'number') {
                            if (material.specular === 0x111111 || material.specular < 0x111111) {
                                material.userData.originalSpecular = null;
                            } else {
                                material.userData.originalSpecular = new THREE.Color(material.specular);
                            }
                        } else {
                            material.userData.originalSpecular = null;
                        }
                    }
                    // Apply environment map for reflections
                    const envMap = typeof window !== 'undefined' && window.app?.sceneManager?.environmentManager?.getEnvironmentMap();
                    if (envMap && !material.envMap) {
                        material.envMap = envMap;
                        if (material.reflectivity === undefined) {
                            material.reflectivity = 0.3;
                        }
                        material.needsUpdate = true;
                    }
                    // Enhance existing Phong/Standard materials - default enabled
                    // Check current enhanced lighting state (if available)
                    const enhancedLighting = typeof window !== 'undefined' && window.app?.sceneManager?.visualizationManager?.showEnhancedLighting !== false;
                    if (enhancedLighting) {
                        if (material.shininess === undefined || material.shininess < 50) {
                            material.shininess = 50;
                        }
                        if (!material.specular ||
                            (material.specular.isColor && material.specular.r < 0.2) ||
                            (typeof material.specular === 'number' && material.specular < 0x333333)) {
                            material.specular = new THREE.Color(0.3, 0.3, 0.3);
                        }
                    }
                    material.needsUpdate = true;
                }
            });

            // Update mesh material (handle arrays)
            if (Array.isArray(child.material)) {
                child.material = materials;
            } else if (materials.length === 1) {
                child.material = materials[0];
            }
        }
    });
}

export { getLoaders };
