import { Session } from 'meteor/session';

import { globalObj } from '/lib/global';
import { Contracts } from '/imports/api/contracts/Contracts';
import { createContract } from '/imports/startup/both/modules/Contract';
import { checkDuplicate, convertToSlug } from '/lib/utils';

/**
* @param {string} contractId - contract where this ballot belongs to
* @param {object} ballot - ballot object
******/
const _setVote = (contractId, ballot) => {
  let candidateBallot = [];

  // see candidate ballots
  if (Session.get('candidateBallot') !== undefined) {
    candidateBallot = Session.get('candidateBallot');
  }
  const multipleChoice = Session.get('contract').multipleChoice;

  //fate
  if (ballot.tick == undefined) { ballot.tick = true } else { ballot.tick = !ballot.tick };

  //add or update ballot in memory
  var update = false;
  for (i in candidateBallot) {
    if (!multipleChoice) {
      candidateBallot[i].ballot.tick = false;
    }
    if (candidateBallot[i].contractId == contractId) {
      if (candidateBallot[i].ballot._id == ballot._id) {
        candidateBallot[i].ballot = ballot
        update = true;
      }
    }
  }
  if (!update) {
    candidateBallot.push({
      contractId: contractId,
      ballot: ballot
    })
  }

  //save to session var
  Session.set('candidateBallot', candidateBallot);
  return ballot.tick;
}

/*****
* @param {string} contractId - contract where this ballot belongs to
* @param {object} ballotId - ballotId to check
******/
let _getVote = (contractId, ballotId) => {
  if (Session.get('rightToVote') == false && Session.get('contract').stage != 'DRAFT') {
    //check if user already voted
    var ledger = Session.get('contract').wallet.ledger
    for (i in ledger) {
      if (ledger[i].entityId == Meteor.user()._id) {
        ballot = ledger[i].ballot;
        for (k in ballot) {
          if (ballot[k]._id == ballotId) {
            return true;
          }
        }
      }
    }
    return false;
  } else {
    //check user current vote
    var votes = Session.get('candidateBallot');
    for (i in votes) {
      if (votes[i].contractId == contractId && votes[i].ballot._id == ballotId) {
        return votes[i].ballot.tick;
      }
    }
  }
}

/****
* checks if at least one item from ballot has been checked for voting
****/
let _ballotReady = () => {
  var votes = Session.get('candidateBallot');
  for (i in votes) {
    if (votes[i].ballot.tick == true) {
      return true;
    }
  }
  return false;
}


/****
* keeps only boolean true values in ballot
* @param {object} ballot - ballot object
* @return {object} options - array with only ticked true ballot options
****/
let _purgeBallot = (options) => {
  var finalBallot = new Array();
  for (i in options) {
    if (options[i].ballot.tick == true) {
      finalBallot.push(options[i].ballot);
    }
  }
  return finalBallot;
}

/******
* shows the results of the current poll
* @param {object} contract - contract to check results on
* @return {array} results - array with a statistical object for every item in the ballot
*******/
let _showResults = (contract) => {
  var results = new Array();
  var ledger = contract.wallet.ledger;
  var ballot = contract.ballot;

  //add votes
  for (i in ledger) {
    if (ledger[i].ballot != undefined && ledger[i].ballot.length > 0) {
      quantity = (ledger[i].quantity / ledger[i].ballot.length);
      for (k in ledger[i].ballot) {
        results = _countVotes(results, ledger[i].ballot[k], quantity);
      }
    }
  }

  //get stats
  var totalvotes = 0;
  for (i in results) {
    totalvotes += results[i].votes;
  }

  //set percentage
  for (i in results) {
    const ballotcount = results[i];
    ballotcount['percentage'] = ((ballotcount.votes * 100) / totalvotes);
    results[i] = ballotcount;
  }

  return results;
}

/******
* updates contract execution status based on final results
* @param {object} contract - contract to check results on
* @param {object} results - object with poll results
*********/
let _updateExecutionStatus = (contract, results) => {
  //check result
  var topvotes = 0;
  for (i in results) {
    if (results[i].votes > topvotes) {
      topvotes = results[i].votes;
      winner = results[i].mode;
    }
  }
  if (topvotes == 0) {
    winner = 'NONE';
  }
  if (contract.stage == 'LIVE') {
    var contractId = contract._id;
    switch (winner) {
      case 'AUTHORIZE':
        Contracts.update({ _id: contractId }, { $set: { executionStatus: 'APPROVED', stage: 'FINISH' } });
        break;
      case 'REJECT':
        Contracts.update({ _id: contractId }, { $set: { executionStatus: 'REJECTED', stage: 'FINISH' } });
        break;
      case 'FORK':
        Contracts.update({ _id: contractId }, { $set: { executionStatus: 'ALTERNATIVE', stage: 'FINISH' } });
        break;
      default:
        Contracts.update({ _id: contractId }, { $set: { executionStatus: 'VOID', stage: 'FINISH' } });
    }
  }
}

/******
* counts the votes in a given ballot
* @param {array} scoreboard - array with all ballots to do counting on
* @param {ballot} ballot - ballot to which compare existence in scoreboard
* @param {number} quantity - amount of votes to add
* @return {array} scoreboard - result board
*******/
let _countVotes = (scoreboard, ballot, quantity) => {
  for (i in scoreboard) {
    if (scoreboard[i]._id == ballot._id) {
      //add votes to exsting item
      scoreboard[i].votes += quantity;
      return scoreboard;
    }
  }
  //new item in ballot
  ballot['votes'] = quantity;
  scoreboard.push(ballot);
  return scoreboard;
}


/******
* generates a new contract that automatically goes as option in the ballot
*******/
let _forkContract = () => {
  if (Session.get('proposalURLStatus') == 'AVAILABLE') {
    var contract = createContract(convertToSlug(Session.get('newProposal')), Session.get('newProposal'))[0];
    if (contract) {
      if (_addChoiceToBallot(Session.get('contract')._id, contract._id)) {
        var contract = Contracts.findOne( { _id: Session.get('contract')._id }, {reactive: false});
        Session.set('dbContractBallot', contract.ballot );
        globalObj.ProposalSearch.search('');
        document.getElementById("searchInput").innerHTML = '';
        Session.set('proposalURLStatus', 'UNAVAILABLE');
        Session.set('createProposal', false);
        Session.set('emptyBallot', false);
        _verifyDraftFork(contract.ballot);
      }
    } else {
      Session.set('duplicateFork', true)
    }
  }
}


let _quickContract = (keyword) => {
  console.log('[createContract] new contract with keyword: ' + keyword);
  //Adds a new contract to db, returns created insert
  if (keyword != undefined || keyword != '') {
    var slug = convertToSlug(keyword);
  } else {
    var slug = convertToSlug('draft-' + Meteor.userId());
  }

  var creationDate = new Date;
  creationDate.setDate(creationDate.getDate() + 1);
  console.log('[createContract] new contract by user: ' + Meteor.userId());

  if (keyword != '') {
    //Creates new contract:
    console.log('[createContract] contract being created...');
    return Contracts.insert({ title: keyword });

  }
}

/**
* verifies if there's an option in the ballot that is still a draft
* @param {object} ballot - ballot to check
*******/
let _verifyDraftFork = (ballot) => {
  var draftFork = false;
  for (var i in ballot) {
    const choice = Contracts.findOne( { _id: ballot[i]._id });
    if (choice.stage == 'DRAFT') {
      draftFork = true;
      break;
    }
  }
  Session.set('draftOptions', draftFork);
}

/******
* updates the ranking of an option in a ballot
* @param {string} contractId - contract
* @param {array} sortedBallotIDs - available options in this ballot
*******/
let _updateBallotRank = (contractId, sortedBallotIDs) => {
  var contract = Contracts.findOne({ _id: contractId });
  var ballot = contract.ballot;
  for (var i in sortedBallotIDs) {
    for (k in ballot) {
      if (ballot[k]._id == sortedBallotIDs[i]) {
        ballot[k].rank = parseInt(i) + 1;
        break;
      }
    }
  }
  contract.ballot = ballot;
  _verifyDraftFork(ballot);
  Contracts.update({ _id: contractId }, { $set: { ballot: contract.ballot } });
}

/******
* removes an option froim a ballot
* @param {string} contractId - contract
* @param {string} forkId - choice id
*******/
let _removeFork = (contractId, forkId) => {
  Contracts.update({ _id: contractId}, { $pull: {
    ballot:
      { _id: forkId}
  }})
};

/******
* adds a choice to the ballot from an existing proposal
* @param {string} contractId - contract
* @param {string} forkId - choice id
* @return {boolean} value - succesfull add
*******/
let _addChoiceToBallot = (contractId, forkId) => {
  var dbContract = Contracts.findOne({ _id: forkId });
  if (dbContract != undefined) {
    if(checkDuplicate(Contracts.findOne(contractId, { ballot: { _id: dbContract._id } }).ballot, dbContract._id) == false) {
      var rankVal = parseInt(Contracts.findOne({ _id: contractId }).ballot.length) + 1;
      Contracts.update(contractId, { $push: {
        ballot:
          {
            _id: dbContract._id,
            mode: 'FORK',
            url: dbContract.url,
            label: dbContract.title,
            rank: rankVal
          }
      }});
      Session.set('duplicateFork', false);
      if (Contracts.findOne({ _id: dbContract._id }).stage == 'DRAFT') {
        Session.set('draftOptions', true);
      }
      Session.set('dbContractBallot', Contracts.findOne( { _id: contractId }, {reactive: false}).ballot );
      return true;
    } else {
      Session.set('duplicateFork', true);
      return false;
    }
  }
}

export const addChoiceToBallot = _addChoiceToBallot;
export const verifyDraftFork = _verifyDraftFork;
export const removeFork = _removeFork;
export const updateBallotRank = _updateBallotRank;
export const updateExecutionStatus = _updateExecutionStatus;
export const showResults = _showResults;
export const purgeBallot = _purgeBallot;
export const ballotReady = _ballotReady;
export const forkContract = _forkContract;
export const setVote = _setVote;
export const getVote = _getVote;
