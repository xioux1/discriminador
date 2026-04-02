import { Router } from 'express';
import { scoreEvaluation } from '../services/scoring.js';

const evaluateRouter = Router();

const REQUIRED_FIELDS = [
  { key: 'prompt_text', minLength: 10 },
  { key: 'user_answer_text', minLength: 5 },
  { key: 'expected_answer_text', minLength: 10 }
];

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}


function badRequest(res, details) {
  return res.status(400).json({
    error: 'bad_request',
    message: 'Invalid JSON payload or unsupported Content-Type.',
    details
  });
}

function validationError(res, details) {
  return res.status(422).json({
    error: 'validation_error',
    message: 'One or more fields failed validation.',
    details
  });
}

evaluateRouter.post('/evaluate', (req, res) => {
  if (!req.is('application/json')) {
    return badRequest(res, [
      {
        field: 'body',
        issue: 'Unsupported Content-Type. Expected application/json.'
      }
    ]);
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return badRequest(res, [
      {
        field: 'body',
        issue: 'Malformed JSON'
      }
    ]);
  }

  const typeErrors = [];

  for (const { key } of REQUIRED_FIELDS) {
    if (key in req.body && typeof req.body[key] !== 'string') {
      typeErrors.push({
        field: key,
        issue: 'Must be a string.'
      });
    }
  }

  if ('subject' in req.body && req.body.subject !== undefined && typeof req.body.subject !== 'string') {
    typeErrors.push({
      field: 'subject',
      issue: 'Must be a string.'
    });
  }

  if (typeErrors.length > 0) {
    return badRequest(res, typeErrors);
  }

  const validationErrors = [];

  const normalizedFields = Object.fromEntries(
    REQUIRED_FIELDS.map(({ key }) => [key, normalize(req.body[key])])
  );

  for (const { key, minLength } of REQUIRED_FIELDS) {
    if (!(key in req.body)) {
      validationErrors.push({
        field: key,
        issue: 'Field is required.'
      });
      continue;
    }

    if (normalizedFields[key].length < minLength) {
      validationErrors.push({
        field: key,
        issue: `Must contain at least ${minLength} non-whitespace characters.`
      });
    }
  }

  if ('subject' in req.body && req.body.subject !== undefined) {
    const subject = normalize(req.body.subject);

    if (subject.length < 1 || subject.length > 60) {
      validationErrors.push({
        field: 'subject',
        issue: 'Must contain between 1 and 60 characters.'
      });
    }
  }

  if (validationErrors.length > 0) {
    return validationError(res, validationErrors);
  }

  const result = scoreEvaluation({
    prompt_text: normalizedFields.prompt_text,
    user_answer_text: normalizedFields.user_answer_text,
    expected_answer_text: normalizedFields.expected_answer_text,
    subject: normalize(req.body.subject)
  });

  return res.status(200).json(result);
});

export default evaluateRouter;
