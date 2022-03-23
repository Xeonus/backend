import { utils } from 'ethers';
import { getContractAt } from '../ethers/ethers';
import { fp } from '../util/numbers';
import beetsAbi from './abi/BeethovenxToken.json';
import { env } from '../../app/env';

const INITIAL_MINT = fp(50_000_000);

const beetsContract = getContractAt(env.BEETS_ADDRESS, beetsAbi);
const fBeetsContract = getContractAt(env.FBEETS_ADDRESS, beetsAbi);

export async function getCirculatingSupply() {
    const totalSupply = await beetsContract.totalSupply();
    return utils.formatUnits(totalSupply.sub(INITIAL_MINT));
}

export async function getUserFBeetsInWalletBalance(userAddress: string): Promise<string> {
    const balance = await fBeetsContract.balanceOf(userAddress);

    return balance.toString();
}
