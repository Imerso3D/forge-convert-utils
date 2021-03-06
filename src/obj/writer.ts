import * as path from 'path';
import * as fse from 'fs-extra';
import * as IMF from '../common/intermediate-format';
import * as THREE from 'three';
import { PropDbReader } from '../common/propdb-reader';

export interface IWriterOptions {
    log?: (msg: string) => void; /** Optional logging function. */
    skipNormals?: boolean;
}

type NodeID = IMF.NodeID
type ObjectNodes = Map<string, NodeID[]>

const myFixed4 = (x: number) => {
    return Math.round(x * 10000)/10000
}
const myFixed2 = (x: number) => {
    return Math.round(x * 100)/100
}

/**
 * Utility class for serializing parsed 3D content to local file system as OBJ.
 */
export class Writer {
    protected options: Required<IWriterOptions>;


    /**
     * Initializes the writer.
     * @param {IWriterOptions} [options={}] Additional writer options.
     */
    constructor(options: IWriterOptions = {}) {
        this.options = {
            log: (options && options.log) || function (msg: string) {},
            skipNormals: options.skipNormals ?? false
        };
    }

    private nodeTransform(node: IMF.IObjectNode): THREE.Matrix4 {

        const matrix = new THREE.Matrix4().identity()

        if (node.transform){

            if (node.transform.kind == IMF.TransformKind.Matrix){
                const m = node.transform.elements
                matrix.set(
                    m[0], m[1], m[2], m[3], 
                    m[4], m[5], m[6], m[7], 
                    m[8], m[9], m[10], m[11], 
                    m[12], m[13], m[14], m[15])
            }
            else if (node.transform.kind == IMF.TransformKind.Decomposed){

                const transform = node.transform as IMF.IDecomposedTransform

                const r = transform.rotation
                const s = transform.scale
                const t = transform.translation
                if (r){
                    matrix.makeRotationFromQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
                }
                if (s){
                    matrix.scale(new THREE.Vector3(s.x, s.y, s.z))
                }
                if (t) {
                    matrix.setPosition(t.x, t.y, t.z)
                }
            }
        }
        return matrix
    }



    private getObjectNodes(imf: IMF.IScene, propdb?: PropDbReader) {
        let buildingNodes = new Map<string, NodeID[]>()
        let openingNodes = new Map<string, NodeID[]>()

        for (let i = 0; i < imf.getNodeCount(); i++) {
            const node = imf.getNode(i)

            if (node.kind !== IMF.NodeKind.Object){
                this.options.log("Skipping node type " + node.kind.toString())
                continue
            }
         
            let isOpening = false
            const props = propdb?.getProperties(node.dbid)
            if (props && props['Element:IfcExportAs'] && props['Element:IfcExportAs'] === 'IfcOpeningElement') {
                isOpening = true
            }

            const id = propdb?.findPropertyRecursive(node.dbid, ['IFC:GLOBALID', 'Element:IfcGUID']) ??`dbid-${node.dbid}`
            
            if (isOpening) {
                openingNodes.get(id)?.push(i) ?? openingNodes.set(id, [i])
            } else {
                buildingNodes.get(id)?.push(i) ?? buildingNodes.set(id, [i])
            }
        }

        return {buildingNodes: buildingNodes, openingNodes: openingNodes}
    }


    private writeObjects(objectNodes: ObjectNodes, outputPath: string, scene: IMF.IScene, rootScale: number) {

        fse.writeFileSync(outputPath, "");

        let output : string[] = []
        let indexOffset = 1

        objectNodes.forEach((nodes: NodeID[], id: string) => {

            output.push("o " + id)
            
            nodes.forEach(nodeId => {
                
                const node = scene.getNode(nodeId)

                if (node.kind !== IMF.NodeKind.Object){
                    throw Error(`Node kind ${node.kind} should have been excluded`)
                }

                const geometry = scene.getGeometry(node.geometry)

                if (geometry.kind === IMF.GeometryKind.Mesh){
        
                    const transform = this.nodeTransform(node)
                    const rotation = new THREE.Matrix4().extractRotation(transform)
        
                    const indices = geometry.getIndices()
                    const vertices = geometry.getVertices()                    
        
                    const numVertices = vertices.length / 3
                    const numIndices = indices.length / 3
        
                    const vIt = vertices.values()
                    for (let v = 0; v < numVertices; v++){
                        const pos = new THREE.Vector3(vIt.next().value, vIt.next().value, vIt.next().value)
                        pos.applyMatrix4(transform).multiplyScalar(rootScale)
                        output.push(`v ${myFixed4(pos.x)} ${myFixed4(pos.y)} ${myFixed4(pos.z)}`)
                    }
        
                    let writingNormals = false
                    if (!this.options.skipNormals){
                        const normals = geometry.getNormals()
                        if (normals){
                            writingNormals = true
                            const nIt = normals.values()
                            for (let i = 0; i < normals.length / 3; i++){
                                const n = new THREE.Vector3(nIt.next().value, nIt.next().value, nIt.next().value)
                                n.applyMatrix4(rotation)
                                output.push(`vn ${myFixed2(n.x)} ${myFixed2(n.y)} ${myFixed2(n.z)}`)
                            }
                        }
                    }
        
                    const faceString = (f0: number, f1: number, f2: number, withNormals: boolean) => {
                        if (withNormals){
                            return `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2}`
                        } else {
                            return `f ${f0} ${f1} ${f2}`
                        }
                    }
        
                    const fIt = indices.values()
                    for (let f = 0; f < numIndices; f++){
        
                        const f0 = indexOffset + fIt.next().value
                        const f1 = indexOffset + fIt.next().value
                        const f2 = indexOffset + fIt.next().value
        
                        output.push(faceString(f0, f1, f2, writingNormals))
                    }
        
                    indexOffset += numVertices
        
                    if (output.length > 50000){
                        fse.appendFileSync(outputPath, output.join("\n") + "\n");
                        output = []
                    }
                }
            })
        })
        
        fse.appendFileSync(outputPath, output.join("\n"));
    }


    /**
     * Outputs scene into OBJ.
     * @async
     * @param {IMF.IScene} imf Complete scene in intermediate, in-memory format.
     * @param {string} outputDir Path to output folder.
     */
    async write(imf: IMF.IScene, outputDir: string, propdb?: PropDbReader) {

        fse.mkdirpSync(outputDir)
        const objPath = path.join(outputDir, 'output.obj');
        const openingObjPath = path.join(outputDir, 'openings.obj');

        const rootScale = this.getRootScale(imf)
        
        const nodeInfo = this.getObjectNodes(imf, propdb)

        this.writeObjects(nodeInfo.buildingNodes, objPath, imf, rootScale)
        this.writeObjects(nodeInfo.openingNodes, openingObjPath, imf, rootScale)

        this.options.log(`Finished writing OBJ`);
    }

    protected getRootScale(imf: IMF.IScene): number {

        const metadata = imf.getMetadata();
        const distanceUnit = metadata['distance unit']?.value;
        if (distanceUnit) {

            switch (distanceUnit) {
                case 'centimeter':
                case 'cm':
                    return 0.01
                case 'millimeter':
                case 'mm':
                    return 0.001
                case 'foot':
                case 'ft':
                    return 0.3048
                case 'inch':
                case 'in':
                    return 0.0254
            }
        }
        return 1.0
    }
}
