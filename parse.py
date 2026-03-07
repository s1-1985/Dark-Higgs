import csv
import sys

input_file = r"c:\Users\user\Desktop\Dark higgs\Claude-Game Development Requirements Planning.csv"
output_file = r"c:\Users\user\Desktop\Dark higgs\cleaned_log.txt"

with open(input_file, 'r', encoding='utf-8') as f_in, open(output_file, 'w', encoding='utf-8') as f_out:
    lines = [line for line in f_in if not line.startswith('#')]
    reader = csv.DictReader(lines)
    for row in reader:
        prompt = row.get('Prompt', '').strip()
        response = row.get('Response', '').strip()
        
        # Remove timestamps from prompts and responses if they exist
        prompt_lines = prompt.split('\n')
        if prompt_lines and prompt_lines[0].startswith('2025/'):
            prompt = '\n'.join(prompt_lines[1:]).strip()
            
        response_lines = response.split('\n')
        if response_lines and response_lines[0].startswith('2025/'):
            response = '\n'.join(response_lines[1:]).strip()
        # also remove 'Thought process:'
        response_lines = response.split('\n')
        cleaned_response = []
        for line in response_lines:
            if line.startswith('Thought process:'):
                continue
            cleaned_response.append(line)
        response = '\n'.join(cleaned_response).strip()
            
        if prompt:
            f_out.write(f"USER: {prompt}\n\n")
        if response:
            f_out.write(f"AI: {response}\n\n")
            f_out.write("-" * 40 + "\n\n")

print(f"Cleaned log written to {output_file}")
