import * as argparse from 'argparse' 
import * as fs from 'fs'
import * as path from 'path'
import * as shell from 'shelljs'
import { genIdentity, genIdentityCommitment } from 'libsemaphore'

import { genSnarkVerifierSol } from './genVerifier'
import {
    buildProveReputationTestCircuit,
    compileAndLoadCircuit,
    executeCircuit,
    genTestProofAndPublicSignals,
    genVerifyReputationProofAndPublicSignals,
    verifyProveReputationProof,
    verifyTestProof,
} from '../test/circuits/utils'

import { genEpochKey, genEpochKeyNullifier, genNewEpochTreeForBenchmark, genNewNullifierTree, genNewNullifierTreeForBenchmark, genNewUserStateTree, genNewUserStateTreeForBenchmark, SMT_ONE_LEAF } from '../test/utils'
import { genRandomSalt, hash5, hashOne, IncrementalQuinTree, stringifyBigInts, unstringifyBigInts } from 'maci-crypto'

import { Reputation } from "../core"


(async function() {
    const zkutilPath = "~/.cargo/bin/zkutil"
    const parser = new argparse.ArgumentParser({ 
        description: 'Compile a circom circuit and generate its proving key, verification key, and Solidity verifier'
    })

    parser.addArgument(
        ['-gst', '--global-state-tree'],
        {
            help: 'The depth of global state tree',
            required: true
        }
    )

    parser.addArgument(
        ['-ust', '--user-state-tree'],
        {
            help: 'The depth of user state tree',
            required: true
        }
    )

    parser.addArgument(
        ['-ept', '--epoch-tree'],
        {
            help: 'The depth of epoch tree',
            required: true
        }
    )

    parser.addArgument(
        ['-nt', '--nullifier-tree'],
        {
            help: 'The depth of nullifier tree',
            required: true
        }
    )

    parser.addArgument(
        ['-epk', '--epoch-key-per-epoch'],
        {
            help: 'The number of epoch keys the user can have per epoch',
            required: true
        }
    )

    parser.addArgument(
        ['-a', '--attestation'],
        {
            help: 'The number of attestations a user can have per epoch key',
            required: true
        }
    )

    parser.addArgument(
        ['-k', '--karma'],
        {
            help: 'The number of karma a user can spend per epoch',
            required: true
        }
    )

    const date = Date.now()
    const args = parser.parseArgs()
    const GSTDepth = args.global_state_tree
    const USTDepth = args.user_state_tree
    const epochTreeDepth = args.epoch_tree
    const nullifierTreeDepth = args.nullifier_tree
    const epochKeyNoncePerEpoch = args.epoch_key_per_epoch
    const attestationNum = args.attestation
    const maxKarmaBudget = args.karma
    const circuitName = "proveReputation"
    let testCircuitContent
    
    const dirPath = path.join(__dirname, '../circuits/benchmark/')
    const circomPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.circom`)
    const circuitOut = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.r1cs`)
    const wasmOut = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.wasm`)
    const symOut = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.sym`)
    const paramsOut = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.params`)

    // create .circom file
    testCircuitContent = `include "../proveReputation.circom" \n\ncomponent main = ProveReputation(${GSTDepth}, ${USTDepth}, ${nullifierTreeDepth}, ${epochTreeDepth}, ${epochKeyNoncePerEpoch}, 252, ${attestationNum}, ${maxKarmaBudget})`

    try{
        fs.mkdirSync(dirPath, { recursive: true })
    } catch(e){
        console.log('Cannot create folder ', e);
    }
    fs.writeFileSync(circomPath, testCircuitContent)

    // // Check if the input circom file exists
    // const inputFileExists = fileExists(circomPath)

    // // Exit if it does not
    // if (!inputFileExists) {
    //     console.error('File does not exist:', circomPath)
    //     return 1
    // }

    // Set memory options for node
    shell.env['NODE_OPTIONS'] = '--max-old-space-size=4096'

    // Compile the .circom file
    const startCompileTime = Math.floor(new Date().getTime())
    console.log(`Compiling ${circomPath}...`)
    shell.exec(`node ./node_modules/circom/cli.js ${circomPath} -r ${circuitOut} -w ${wasmOut} -s ${symOut}`)
    console.log('Generated', circuitOut, 'and', wasmOut)
    const endCompileTime = Math.floor(new Date().getTime())
    console.log(`Compile time: ${endCompileTime - startCompileTime} ms`)
    
    // Generate params file
    console.log('Generating params file...')
    shell.exec(`${zkutilPath} setup -c ${circuitOut} -p ${paramsOut}`)

    // Generate inputs for test circuit
    // User state
    const epoch = 1
    const nonce = 1
    const user = genIdentity()
    const proveKarmaAmount = 3
    const nonceStarter = 0
    const epochKeyNonce = 0
    const epochKey = genEpochKey(user['identityNullifier'], epoch, epochKeyNonce, epochTreeDepth)
    let minRep = null
    let reputationRecords = {}
    const userStateTree = await genNewUserStateTreeForBenchmark(USTDepth)

    // Bootstrap user state
    for (let i = 0; i < attestationNum; i++) {
        let attesterId = Math.ceil(Math.random() * (2 ** USTDepth - 1))
        while (reputationRecords[attesterId] !== undefined) attesterId = Math.floor(Math.random() * (2 ** USTDepth))
        const graffitiPreImage = genRandomSalt()
        reputationRecords[attesterId] = new Reputation(
            BigInt(Math.floor(Math.random() * 100) + 10),
            BigInt(Math.floor(Math.random() * 10)),
            hashOne(graffitiPreImage),
        )
        reputationRecords[attesterId].addGraffitiPreImage(graffitiPreImage)
        await userStateTree.update(BigInt(attesterId), reputationRecords[attesterId].hash())
    }

    const userStateRoot = userStateTree.getRootHash()
    
    // Global state tree
    let GSTZERO_VALUE = 0
    const transitionedPosRep = 5
    const transitionedNegRep = 0
    const GSTree = new IncrementalQuinTree(GSTDepth, GSTZERO_VALUE, 2)
    const commitment = genIdentityCommitment(user)
    const hashedLeaf = hash5([
        commitment, 
        userStateRoot,
        BigInt(transitionedPosRep),
        BigInt(transitionedNegRep),
        BigInt(0)
    ])
    
    GSTree.insert(hashedLeaf)
    const GSTreeProof = GSTree.genMerklePath(0)
    const GSTreeRoot = GSTree.root

    // Nullifier tree
    const nullifierTree = await genNewNullifierTreeForBenchmark(nullifierTreeDepth)
    const nullifierTreeRoot = nullifierTree.getRootHash()

    const epkNullifier = genEpochKeyNullifier(user['identityNullifier'], epoch, nonce, nullifierTreeDepth)
    const epkNullifierProof = await nullifierTree.getMerkleProof(epkNullifier)

    const selectors: BigInt[] = []
    const nonceList: BigInt[] = []
    for (let i = 0; i < proveKarmaAmount; i++) {
        nonceList.push( BigInt(nonceStarter + i) )
        selectors.push(BigInt(1));
    }
    for (let i = proveKarmaAmount ; i < maxKarmaBudget; i++) {
        nonceList.push(BigInt(0))
        selectors.push(BigInt(0))
    }

    const circuitInputs = {
        epoch: epoch,
        nonce: nonce,
        identity_pk: user['keypair']['pubKey'],
        identity_nullifier: user['identityNullifier'], 
        identity_trapdoor: user['identityTrapdoor'],
        user_tree_root: userStateRoot,
        user_state_hash: hashedLeaf,
        epoch_key_nonce: epochKeyNonce,
        epoch_key: epochKey,
        GST_path_index: GSTreeProof.indices,
        GST_path_elements: GSTreeProof.pathElements,
        GST_root: GSTreeRoot,
        nullifier_tree_root: nullifierTreeRoot,
        nullifier_path_elements: epkNullifierProof,
        selectors: selectors,
        positive_karma: transitionedPosRep,
        negative_karma: transitionedNegRep,
        prove_karma_nullifiers: BigInt(Boolean(proveKarmaAmount)),
        prove_karma_amount: BigInt(proveKarmaAmount),
        karma_nonce: nonceList,
        prove_min_rep: minRep != null ? true: false,
        min_rep: minRep != null ? BigInt(minRep) : BigInt(0),
    }

    // generate circuit proof

    const inputJsonPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.input.json`)
    const witnessPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.witness.wtns`)
    const witnessJsonPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.witness.json`)
    const proofPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.proof.json`)
    const publicJsonPath = path.join(__dirname, `../circuits/benchmark/${circuitName}_${date}.publicSignals.json`)

    fs.writeFileSync(inputJsonPath, JSON.stringify(stringifyBigInts(circuitInputs)))

    const startGenProofTime = Math.floor(new Date().getTime())
    const snarkjsCmd = 'node ' + path.join(__dirname, '../node_modules/snarkjs/build/cli.cjs')
    const witnessCmd = `${snarkjsCmd} wc ${wasmOut} ${inputJsonPath} ${witnessPath}`

    shell.exec(witnessCmd)

    const witnessJsonCmd = `${snarkjsCmd} wej ${witnessPath} ${witnessJsonPath}`
    shell.exec(witnessJsonCmd)

    const proveCmd = `${zkutilPath} prove -c ${circuitOut} -p ${paramsOut} -w ${witnessJsonPath} -r ${proofPath} -o ${publicJsonPath}`

    shell.exec(proveCmd)
    const endGenProofTime = Math.floor(new Date().getTime())
    console.log(`Generate proof time: ${endGenProofTime - startGenProofTime} ms`)

    shell.rm('-f', witnessPath)
    shell.rm('-f', witnessJsonPath)
    shell.rm('-f', inputJsonPath)

    // verify proof
    const startVerifyTime = Math.floor(new Date().getTime())
    const verifyCmd = `${zkutilPath} verify -p ${paramsOut} -r ${proofPath} -i ${publicJsonPath}`
    const output = shell.exec(verifyCmd).stdout.trim()
    const endVerifyTime = Math.floor(new Date().getTime())
    console.log(`Verify proof time: ${endVerifyTime - startVerifyTime} ms`)

    shell.rm('-f', circuitOut)
    shell.rm('-f', wasmOut)
    shell.rm('-f', symOut)
    shell.rm('-f', paramsOut)
    shell.rm('-f', proofPath)
    shell.rm('-f', publicJsonPath)

    if(output != "Proof is correct"){
        console.log('ERROR')
        console.log(circuitInputs)
    }

    return 0
})();
